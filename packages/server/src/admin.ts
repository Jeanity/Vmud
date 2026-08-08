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
  AUTHORED_ROOM_BASE,
  AUTHORED_VNUM_BASE,
  AffectFlag,
  EQUIP_SLOTS,
  LPC_ART,
  LPC_ART_BY_ID,
  ROOM_FLAGS,
  SECTORS,
  UNLIMITED_DURATION,
  AUTHORED_MOB_BASE,
  SPELL_IDS,
  formatArtId,
  isKnownArt,
  isSpellId,
  spellByName,
  suggestColour,
  type SpellId,
  newAffect,
  parseArtId,
  parseDice,
  parseDirection,
  placeKey,
  stripColour,
  writeDice,
  type Dice,
  type Direction,
  type EquipSlot,
  type ItemTemplate,
  type MobTemplate,
  type Place,
  type Room,
  type RoomFlag,
  type RoomId,
  type Sector,
  type ZoneId,
} from '@mygame/shared';
// A subpath import, as `vision.ts` is in `players.ts`: the catalogue is not in the package barrel.
import { LIGHT_SOURCES, lightSource, type LightSource } from '@mygame/shared/light.ts';

import { askOnce, draftDescription, listModels, ollamaReachable } from './ollama.ts';
import { saveRoomOverrides, type RoomOverride } from './overrides.ts';
import { saveAuthoredMobs, type AuthoredMobStore, type MobDraft } from './mob-authoring.ts';
import {
  MAX_PLACEMENTS_PER_MOB,
  MAX_PLACEMENT_LIMIT,
  savePlacements,
  type Placement,
  type Placements,
} from './placements.ts';
import {
  MAX_AUTHORED_AC,
  MAX_AUTHORED_EXPERIENCE,
  MAX_AUTHORED_LEVEL,
  MAX_AUTHORED_LOOT,
  MAX_AUTHORED_WIMPY,
  saveMobOverrides,
  type AuthoredLoot,
  type MobOverride,
  type MobOverrides,
} from './mob-overrides.ts';
import { draftQuest, saveQuests, type QuestDef, type QuestDraft } from './quests.ts';
import { draftAuthoredRoom, narrowsExtent, saveAuthoredRooms, takeAuthoredRoomId } from './room-authoring.ts';
import { ZONE_NAME_MAX, readZoneName, saveAuthoredZones, takeAuthoredZoneId } from './zone-authoring.ts';
import {
  MAX_AUTHORED_LIGHT_RADIUS,
  readAuthoredLight, readDice, saveItemOverrides, type ItemOverride, type ItemOverrides } from './item-overrides.ts';
import type { AuthoredItems, ItemDraft } from './item-authoring.ts';
import type { AccountStore } from './accounts.ts';
import { seenTileCount, slugify, type PlayerStore, type StoredSummary } from './players.ts';
import type { WorldSettings } from './settings.ts';
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
  /**
   * Query parameters, already decoded. Empty for every route but the item search.
   *
   * Added with the Items panel, which is the first read that **cannot** put its argument in the path:
   * a catalogue of 16,421 entries has to be searched rather than listed, and a free-text term with
   * spaces and punctuation in it is not a path segment. A `POST` with a body would have been the other
   * option and is worse — searching is a read, and a read that cannot be linked to or refreshed is a
   * read wearing the wrong verb.
   */
  readonly query?: Readonly<Record<string, string>>;
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

  /**
   * Empties a room of everything that is not a player — A8 slice 2, and it runs *before* the room is
   * taken out from under them.
   *
   * **Not `slayMob`**, which is the opposite of what is wanted here: a slay leaves a corpse, and a
   * corpse in a room that is about to stop existing is the thing this exists to prevent. Nothing died;
   * the room did. Mobs are removed outright and repop into whatever is left of the zone on the next
   * reset, which is the honest outcome — their reset command still names a room, and `reset.ts` has
   * always skipped a command it cannot place.
   *
   * Players are **not** touched, because the router refuses to delete a room anybody is standing in.
   * That refusal is the design: an operator has `teleport` and `kick`, and moving somebody without
   * telling them is a worse answer than saying who is in the way.
   */
  clearRoom(room: RoomId): { readonly mobs: number; readonly corpses: number; readonly items: number };

  /**
   * How many reset commands name this room, by kind — `DESIGN-zone-geometry.md` decision 4.
   *
   * **A read that exists solely to be shown at delete time**, and that is the whole of decision 4:
   * `reset.ts` is already defensive, so an orphaned command is skipped in silence on every boot for
   * ever. The spawn files are a worldgen output and an authored delete cannot edit them, so the
   * commands come back on every rebuild — which makes the moment of deletion the only moment anybody
   * will ever be told.
   */
  resetsNaming(room: RoomId): Readonly<Record<string, number>>;

  /**
   * Throws away every character's explored map of a Place, and tells the people standing on it —
   * A8 slice 3, and the price of moving a grid.
   *
   * **A cleared map is the only honest one of the three outcomes.** Tile indices are row-major and
   * measured from the extent's corner, so a resized grid does not make a saved map *incomplete*, it
   * makes it *wrong*: the fog would be lifted off tiles nobody has been to and drawn over ones they
   * have. Keeping it is impossible, re-mapping it needs the old grid's width (which is not stored)
   * and would have to be right for every offline character too, and leaving it shifted is the version
   * a player reports as the fog being broken.
   *
   * Three things happen together and must not be separable: the stored bitsets go, for **everyone**
   * rather than only whoever is online; every actor on the Place is re-seated, because tile positions
   * are measured from the same corner that just moved; and the players there are sent the new grid,
   * an empty map, and a line saying so — finding out by walking into a wall is not acceptable.
   *
   * Returns how many characters lost a map, which is what makes "was that as bad as I thought" an
   * answerable question at the moment of doing it.
   */
  forgetPlace(place: Place): { readonly characters: number; readonly told: number };

  /* ---- A4: zones and mobs, live ------------------------------------------ */

  /**
   * Runs a zone's reset **now** and re-arms its clock, returning what it did.
   *
   * `runReset` has taken a `force` flag since Phase 8 and only boot has ever passed it — this is the
   * second caller, and forcing matters for a reason beyond impatience (§4.9): on a *timed* reset an
   * `M` command below 100% never fires at all, so a forced pass is the only time a percentage is
   * consulted. Nothing in the shipped world is below 100 today; the day one arrives, the tester needs
   * the path that reads it.
   *
   * **Additive, exactly as the timed one is.** Nothing despawns, and the per-vnum world-wide limits
   * still hold, so hammering this does not fill a zone — which is what makes it safe to give an
   * operator a button for. Undefined for a zone with no population file.
   */
  repopZone(zone: ZoneId): { readonly spawned: number; readonly doors: number; readonly objects: number; readonly atLimit: number } | undefined;

  /**
   * Opens, shuts or locks a door, from the operator's side rather than a character's.
   *
   * **Both ends, always** — `world.doorway()` exists precisely because a doorway worked from one side
   * only is a wall from the other, and the 5 exits in the shipped world that face a door without
   * declaring one share the carved strip with the side that does.
   *
   * Not routed through `do_open`: that checks reach, position and whether the character has a key,
   * and an operator has none of those things. The refusals it *does* keep are the ones about the
   * world rather than the actor — there has to be a door there at all.
   */
  workDoor(room: RoomId, dir: string, next: { readonly closed?: boolean; readonly locked?: boolean }):
    | { readonly name: string; readonly closed: boolean; readonly locked: boolean }
    | { readonly error: string };

  /**
   * Every live mob in a zone, as instances rather than as templates.
   *
   * The distinction is the whole point of the section: the Zones browser lists what a zone is
   * *authored* to contain, and this lists what is standing in it right now — three kobold guards of
   * one vnum, two of them wounded, one of them chasing somebody. An **entity id** on every row,
   * because that is the only thing that says *which*, exactly as protocol 11 argued for the target
   * menu.
   */
  mobsIn(zone: ZoneId): readonly {
    readonly id: number;
    readonly vnum: number;
    readonly name: string;
    readonly level: number;
    readonly hp: number;
    readonly maxHp: number;
    readonly room: RoomId;
    readonly roomName: string;
    readonly status: string;
    /** The entity id it is fighting, when it is in a fight. */
    readonly fighting?: number;
  }[];

  /**
   * Kills one mob by entity id, through the game's own death path.
   *
   * **Through `resolveDeath`, not by deleting it**, so it leaves a corpse holding what it carried,
   * pays out no experience to nobody, and tells the room. An admin slay that made a body vanish would
   * be testing a code path the game does not have — and the mob-testing loop exists to watch the real
   * one.
   */
  slayMob(id: number): { readonly name: string } | undefined;

  /**
   * Puts one instance of a harvested template into a room.
   *
   * The vnum is the mob's own, the same join key everything else uses. Refuses a template this server
   * did not load rather than inventing one: a spawn table names mobs by number and a number with no
   * record behind it is a typo, not a request.
   */
  spawnMob(vnum: number, room: RoomId): { readonly id: number; readonly name: string } | { readonly error: string };

  /** Every harvested mob template, for the spawn picker. Searched rather than listed, like items. */
  mobTemplates(): readonly { readonly vnum: number; readonly name: string; readonly level: number; readonly keywords: readonly string[] }[];

  /**
   * A4c: what each mob template is authored to carry. Read for the ✎ mark and for saving; never
   * mutated here — the same split every other overlay keeps between the router that validates and the
   * world that applies.
   */
  mobOverrides(): MobOverrides;

  /** How many of a mob vnum are standing in the world right now. See {@link authorMobLoot}. */
  liveCountOf(vnum: number): number;

  /**
   * Writes a template's loot, and says what it now stands at.
   *
   * **It does not touch anything already standing in the world**, and that is worth stating rather
   * than discovering: loot is per *template*, so it lands on the next thing to spawn from that vnum
   * and not on the ninety already walking around. The panel says so, and A4's repop button is what
   * turns the edit into something you can go and look at.
   */
  authorMobLoot(vnum: number, loot: readonly AuthoredLoot[]): MobOverride | undefined;

  /** One mob template as it now stands, overlay folded in. **A9** — what the field editor opens on. */
  mobTemplateOf(vnum: number): MobTemplate | undefined;

  /**
   * One authored edit to a mob template, applied live. **A9**, and {@link authorItem}'s twin.
   *
   * Rebuilt from the pristine harvest plus whatever the merged override still says, so clearing a field
   * restores the harvest rather than the last edit. Like loot, it lands on **everything spawned from
   * here on and nothing already standing** — the same sentence, because it is the same mechanism.
   */
  authorMob(
    vnum: number,
    next: Partial<MobOverride>,
    cleared: readonly string[],
  ): MobTemplate | undefined;

  /** A9b: mobs made here rather than harvested. Read for the *created* mark and for saving. */
  authoredMobs(): AuthoredMobStore;

  /**
   * A9b: create a mob, or re-draft one made here. `vnum` is `undefined` to create — the number is the
   * server's to allocate, so a form cannot ask for one a re-harvest might later claim.
   */
  authorNewMob(vnum: number | undefined, draft: MobDraft): { mob: MobTemplate } | { error: string };

  /** A9b: unmake a created mob. Nothing already standing is touched; nothing new spawns. */
  unmakeMob(vnum: number): { name: string; standing: number } | undefined;

  /** A9c: where each mob is authored to live. Read for the panel and for saving. */
  placements(): Placements;

  /**
   * A9c: assign a creature its rooms, replacing whatever it had. An empty list unplaces it.
   *
   * **Applied to the live reset tables as well as the overlay**, which is the difference between a
   * placement that works and one that works after a restart — a zone clock copies its table at boot.
   */
  placeMob(vnum: number, rows: readonly Placement[]): readonly Placement[] | undefined;

  /** The operator switches as they currently stand. See `settings.ts`. */
  settings(): WorldSettings;
  /** The authored item overlay — read for edited marks and for saving; never mutated here. */
  itemOverrides(): ItemOverrides;
  /**
   * One authored edit to an item, applied to the live catalogue. Returns the template as it now
   * stands, or nothing for a vnum the catalogue does not have. The router validates; this applies —
   * the same split `authorRoom` keeps with the world.
   */
  authorItem(vnum: number, next: Partial<ItemOverride>, cleared: readonly string[]): ItemTemplate | undefined;

  /**
   * A6b: items created here rather than harvested. Read for the *created* mark; never mutated here.
   *
   * A separate hook from {@link itemOverrides} because they are separate stores with opposite rules —
   * one holds patches that vanish when they author nothing, the other whole records that persist until
   * deleted. See `item-authoring.ts`.
   */
  authoredItems(): AuthoredItems;
  /**
   * Creates an item, or re-drafts one that was created here. `vnum` undefined creates.
   *
   * **The number is allocated by this side, never accepted from the caller** — a form that could pick
   * its own vnum could pick one a future harvest will claim, and vnum collisions are not merge
   * conflicts, they are two items silently becoming one.
   */
  authorNewItem(vnum: number | undefined, draft: ItemDraft, by: string): { item: ItemTemplate } | { error: string };
  /** Removes a created item. Refuses anything it did not create — a harvested item cannot be deleted. */
  deleteAuthoredItem(vnum: number): boolean;

  /**
   * Instantiates a catalogue item into a live character's bag, and tells them.
   *
   * Returns the item's name so the audit line and the panel can both say *what* was given rather than
   * only its vnum. A refusal carries its reason — a full bag is a real answer, not a failure.
   */
  giveItem(player: Player, vnum: number): { name: string } | { error: string };

  /**
   * Throws a switch: applies it live and writes it to disk in the same breath.
   *
   * One call rather than a set-then-save pair, because the two must not be separable — a switch
   * applied and not saved reverts silently on the next restart, which is the failure mode that gets
   * somebody killed by a rule nobody meant to be in force.
   */
  setSettings(next: WorldSettings): void;

  /* ---- A7q: quests ------------------------------------------------------- */

  /** The authored quests as the running world holds them. The read half; the router does the rest. */
  quests(): ReadonlyMap<string, QuestDef>;

  /**
   * Replaces the live definitions **and re-seeds everything that hangs off them**, in one call.
   *
   * One function rather than a setter plus two seeders, for the reason {@link setSettings} gives about
   * apply-and-save: the three must not be separable. `index.ts` seeds three things from one set of rows
   * at boot — the quest map the `quest` verb reads, `sim.setQuestGivers` for the view's `?` badge, and
   * `combat.ts`'s untouchable registry — and the whole point of seeding them together is that the badge
   * and the immunity cannot come to disagree. A route that could update one of the three would be a
   * route that can produce a mob wearing a `?` that anybody may kill.
   *
   * Returns the giver vnums as they now stand, and **how many bodies were re-sent to their watchers**:
   * a quest deleted out from under a standing giver has to take its badge and its armour with it, and
   * `resynced` is the number that says whether anybody actually saw that happen.
   */
  setQuests(next: readonly QuestDef[]): { readonly givers: readonly number[]; readonly resynced: number };
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
  /**
   * Who may connect, and which characters are theirs — DESIGN-accounts.md §7. The admin surface
   * *is* the password-reset path (there is no email on purpose), so this dep is required: an admin
   * panel that cannot reset a password makes the no-email decision a lie.
   */
  readonly accounts: AccountStore;
  readonly live: LiveOps;
  /**
   * The harvested item catalogue, by vnum — what the Items section reads.
   *
   * Injected rather than loaded here for the reason every other world fact is: `index.ts` owns loading
   * and this file owns answering. It is also **empty on a checkout with no Duris source**, which is not
   * an error — `data/zones-source/` is git-ignored, so the honest answer for a catalogue that was never
   * built is a section that says so rather than a route that 500s.
   */
  readonly items: ReadonlyMap<number, ItemTemplate>;
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
  /** Where authored items are saved, or undefined to edit the live catalogue without persisting. */
  readonly itemOverridesFile: string | undefined;
  /**
   * Where **created** rooms are saved, or undefined to build in the live world without persisting.
   *
   * A separate path from {@link overridesFile} because they are separate files, and separate files
   * because their lifecycles are opposite — `room-authoring.ts`'s table has the four rules.
   */
  readonly authoredRoomsFile: string | undefined;
  /** A8d: where created zones are written. Absent in tests that assert without touching disk. */
  readonly authoredZonesFile?: string | undefined;
  /** Where authored mob loot is saved, or undefined to edit the live world without persisting. */
  readonly mobOverridesFile: string | undefined;
  /** A9b: where created mobs are written. Absent in tests that assert without touching disk. */
  readonly authoredMobsFile?: string | undefined;
  /** A9c: where placements are written. Absent in tests that assert without touching disk. */
  readonly placementsFile?: string | undefined;
  /**
   * A7q: where the authored quests are written. Absent in tests that assert without touching disk.
   *
   * The same shape as its five siblings above, and pointed at `quests.ts`'s own constant in `index.ts`
   * so the loader and the writer can never drift apart on the path.
   */
  readonly questsFile?: string | undefined;
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

/**
 * What an item PATCH may carry — the authorable content of `item-overrides.ts`, plus provenance.
 *
 * The refusal message for anything else names the reason, exactly as the room editor's does: `slot`,
 * `type` and `container` are *behaviour* derived from Duris' own bits, and `stackLimit`/`uses` are
 * §3's type-derived rules. An editor that could set them would be half a mechanics editor with none
 * of the validation one needs.
 */
// A7b adds `art`. It sits with the content fields rather than the refused behaviour ones because
// choosing a sword's picture changes nothing about what the sword does.
const ITEM_PATCH_KEYS = new Set(['name', 'keywords', 'ac', 'damage', 'cost', 'art', 'light', 'slot', 'weaponClass', 'by']);

/**
 * A9. What may be authored on a mob — and `loot` is **not** in it, deliberately.
 *
 * Loot is a list against the item catalogue with its own validation and its own route, and folding it in
 * here would mean one endpoint whose body is half a form and half a table.
 */
const MOB_PATCH_KEYS = new Set([
  'spells',
  'name',
  'room',
  'keywords',
  'level',
  'hp',
  'damage',
  'armourClass',
  'experience',
  'wimpyAt',
  'sprite',
  'by',
]);
const MOB_NAME_MAX = 120;
/** A mob's room line is a sentence, not a paragraph: *“A sentry stands here, watching the gate.”* */
const MOB_ROOM_MAX = 400;
const MOB_KEYWORD_MAX = 30;
const MOB_SPRITE_MAX = 80;

/**
 * One mob template as the panel reads it — **the whole authorable record, and nothing derived**.
 *
 * `combat.attackBonus` and `combat.roundMs` are omitted on purpose even though the editor changes them:
 * they are functions of the level, so showing them beside an editable level would invite somebody to set
 * one and watch it be overwritten. The two that *are* authorable, armour class and damage, are lifted out
 * of `combat` and flattened, because the form edits fields and not a nested record.
 */
function mobTemplateRow(template: MobTemplate): Record<string, unknown> {
  return {
    ...mobDraftOf(template),
    vnum: template.vnum,
    name: template.name,
    room: template.room,
    keywords: template.keywords,
    level: template.level,
    hp: template.hp,
    damage: writeDice(template.combat.damage),
    armourClass: template.combat.armourClass,
    experience: template.experience,
    wimpyAt: template.wimpyAt,
    sprite: template.sprite,
  };
}

/**
 * A template reduced to the draft a form posts back — **A9b**.
 *
 * The two rule booleans are the interesting part. `aggro` and `pursuit` are whole records, and the panel
 * never sees them as such: {@link MobDraft.aggressive} is one flag that writes a disposition *and* its
 * clause together, which is what makes it safe to offer at all. Read back the same way, from the fields
 * that actually decide the behaviour rather than from a stored flag that could disagree with them.
 */
function mobDraftOf(template: MobTemplate): Record<string, unknown> {
  return {
    name: template.name,
    room: template.room,
    keywords: template.keywords,
    level: template.level,
    hp: template.hp,
    damage: writeDice(template.combat.damage),
    armourClass: template.combat.armourClass,
    experience: template.experience,
    wimpyAt: template.wimpyAt,
    sprite: template.sprite,
    aggressive: template.aggro.disposition !== 'passive' && template.aggro.clauses.length > 0,
    hunts: template.pursuit.trackRooms > 0,
  };
}
const ITEM_NAME_MAX = 120;
const ITEM_KEYWORD_MAX = 30;
const ITEM_AC_MAX = 50;

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

/**
 * Exported for the game socket's claim gate (DESIGN-accounts.md §6): "is this connection loopback"
 * is one trust decision, and two definitions of it would eventually disagree.
 */
export const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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
    // A7f. On the async branch beside `describe`, because it may talk to Ollama — and for the same
    // reason `ollama.ts` gives: a model is the least deterministic thing on the machine and must never
    // sit on a path the tick can wait on.
    if (head === 'items' && slug !== undefined && action === 'colour' && parts.length === 3 && request.method === 'POST') {
      return this.suggestItemColour(slug, request.body);
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
    // A8d. A zone from nothing — the id is the server's, and which zones *load* stays a file.
    if (head === 'zones' && parts.length === 1 && request.method === 'POST') return this.createZone(request.body);
    if (head === 'zones' && slug !== undefined && action === 'rooms' && parts.length === 3 && request.method === 'GET') {
      return this.zoneRooms(slug);
    }
    // A4. Zone-scoped live ops: what is standing in it, and making it repop.
    if (head === 'zones' && slug !== undefined && action === 'mobs' && parts.length === 3 && request.method === 'GET') {
      return this.zoneMobs(slug);
    }
    if (head === 'zones' && slug !== undefined && action === 'repop' && parts.length === 3 && request.method === 'POST') {
      return this.repop(slug);
    }
    // A8. Creating a room is scoped to the zone it goes in — the extent it must fit inside and the
    // neighbours it joins are that zone's, and there is no world-level answer to where a room goes.
    if (head === 'zones' && slug !== undefined && action === 'rooms' && parts.length === 3 && request.method === 'POST') {
      return this.createRoom(slug, request.body);
    }
    // A4. `/mobs` is the template catalogue (a read, searched) and `/mobs/:id` one live instance.
    if (head === 'mobs' && parts.length === 1 && request.method === 'GET') return this.mobs(request.query);
    if (head === 'mobs' && parts.length === 1 && request.method === 'POST') return this.spawnMob(request.body);
    if (head === 'mobs' && slug !== undefined && parts.length === 2 && request.method === 'DELETE') {
      return this.slayMob(slug);
    }
    // A4c. **A vnum, where the route above takes an entity id** — the two are genuinely different
    // questions (this template, against that body), so they get different paths rather than one path
    // whose meaning depends on the verb.
    if (head === 'mobs' && slug !== undefined && action === 'loot' && parts.length === 3 && request.method === 'PATCH') {
      return this.authorMobLoot(slug, request.body);
    }
    // A9b. A creation has no vnum to name it by, so it posts to the collection — `/mobs` itself is taken
    // by `POST` for *spawning an instance*, which is a different act on a different id space, so a made
    // creature goes to `/mobs/template` exactly as an edited one goes to `/mobs/:vnum/template`.
    if (head === 'mobs' && slug === 'template' && parts.length === 2 && request.method === 'POST') {
      return this.createMob(request.body);
    }
    // A9. Under `/template` for the reason above rather than at `/mobs/:vnum`: `DELETE /mobs/:id` already
    // took that path for an **entity id**, and one path whose id space depends on the verb is exactly what
    // the note above says not to build. `/loot` and `/template` are both “this kind of mob”; `/mobs/:id`
    // is “that body”.
    // A9c. Beside `/loot` and `/template` and for the same reason: all three are facts about *this kind of
    // mob*, keyed by vnum, where `/mobs/:id` is that body over there.
    if (head === 'mobs' && slug !== undefined && action === 'placements' && parts.length === 3) {
      if (request.method === 'GET') return this.mobPlacements(slug);
      if (request.method === 'PUT') return this.placeMob(slug, request.body);
    }
    if (head === 'mobs' && slug !== undefined && action === 'template' && parts.length === 3) {
      if (request.method === 'GET') return this.mobTemplate(slug);
      if (request.method === 'PATCH') return this.authorMob(slug, request.body);
      if (request.method === 'DELETE') return this.destroyMob(slug);
    }
    // A4. A door is named by the room it is in and the way it faces — not by an id, because it has
    // none: a doorway is two exits, and `world.doorway` is what keeps the two ends in step.
    if (head === 'rooms' && slug !== undefined && action === 'door' && parts.length === 3 && request.method === 'POST') {
      return this.workDoor(slug, request.body);
    }
    if (head === 'rooms' && slug !== undefined && parts.length === 2) {
      if (request.method === 'GET') return this.room(slug);
      if (request.method === 'PATCH') return this.authorRoom(slug, request.body);
      // A8 slice 2. Not scoped to a zone the way creation is: a room already knows which zone it is
      // in, and asking the caller to repeat it is a second thing they can get wrong.
      if (request.method === 'DELETE') return this.deleteRoom(slug);
    }
    if (head === 'announce' && parts.length === 1 && request.method === 'POST') {
      return this.announce(request.body);
    }
    if (head === 'settings' && parts.length === 1) {
      if (request.method === 'GET') return { status: 200, body: { settings: this.deps.live.settings() } };
      if (request.method === 'PATCH') return this.patchSettings(request.body);
    }
    // A7b. The art an item may be given — generated by `npm run artgen`, so the panel never guesses.
    if (head === 'art' && parts.length === 1 && request.method === 'GET') return this.art(request.query);
    if (head === 'items' && parts.length === 1 && request.method === 'GET') return this.items(request.query);
    // A6b. `POST /items` creates; the vnum comes back in the response because the server allocates it.
    if (head === 'items' && parts.length === 1 && request.method === 'POST') return this.createItem(request.body);
    if (head === 'items' && slug !== undefined && parts.length === 2) {
      if (request.method === 'GET') return this.item(slug);
      if (request.method === 'PATCH') return this.authorItem(slug, request.body);
      if (request.method === 'DELETE') return this.destroyItem(slug);
    }
    // A7q. **Keyed by a slug rather than a number**, alone among the authoring sections — a quest's id
    // is its own join key into every character's save file, so it is a name somebody chose and not a
    // vnum somebody was allocated. Which is also why there is no `POST /quests/template` split: a quest
    // has no *instance* id space for `/quests/:id` to collide with.
    if (head === 'quests' && parts.length === 1 && request.method === 'GET') return this.quests();
    if (head === 'quests' && parts.length === 1 && request.method === 'POST') return this.createQuest(request.body);
    if (head === 'quests' && slug !== undefined && parts.length === 2) {
      if (request.method === 'PATCH') return this.authorQuest(slug, request.body);
      if (request.method === 'DELETE') return this.destroyQuest(slug);
    }
    // DESIGN-accounts.md §7. Three routes, and they are the whole reset story: with no email on an
    // account, the operator over loopback is what "forgot my password" resolves to.
    if (head === 'accounts' && parts.length === 1 && request.method === 'GET') return this.accounts();
    if (head === 'accounts' && slug !== undefined && action === 'password' && parts.length === 3 && request.method === 'POST') {
      return this.resetPassword(slug, request.body);
    }
    if (head === 'accounts' && slug !== undefined && action === 'claim' && parts.length === 3 && request.method === 'POST') {
      return this.assignCharacter(slug, request.body);
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
      if (action === 'give') return this.give(slug, request.body);
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
   * The item catalogue, searched.
   *
   * **Searched rather than listed, because 16,421 entries is not a page.** The whole catalogue is about
   * three megabytes of JSON; sending it once and filtering in the browser would be simpler and would
   * make the panel's first paint wait on it, so the term goes to the server and a bounded page comes
   * back. `total` is reported separately from the rows so the operator can see when a search is too
   * broad rather than silently reading the first fifty of nine hundred.
   *
   * Matched on **keywords, name and vnum**. Keywords are Duris' own authored list — the thing a player
   * would type — and the display name carries colour codes, so the name is matched with them stripped:
   * searching for `silver` must find `&+Ca silver dagger&N`, and it would not against the raw string.
   */
  private items(query: Readonly<Record<string, string>> | undefined): AdminResponse {
    const term = (query?.['q'] ?? '').trim().toLowerCase();
    const kind = (query?.['kind'] ?? '').trim();
    const limit = Math.max(1, Math.min(200, Number(query?.['limit'] ?? 50) || 50));

    const matches: ItemTemplate[] = [];
    for (const template of this.deps.items.values()) {
      if (kind === 'weapon' && !template.damage) continue;
      if (kind === 'armour' && template.ac <= 0) continue;
      if (kind === 'container' && !template.container) continue;
      if (kind === 'twoHanded' && !template.twoHanded) continue;
      if (term && !itemMatches(template, term)) continue;
      matches.push(template);
    }
    // By vnum, which is the catalogue's own order and the one an operator can navigate: neighbouring
    // vnums are the same builder's work in the same file, so a search result reads as a group.
    matches.sort((a, b) => a.vnum - b.vnum);

    return {
      status: 200,
      body: {
        total: matches.length,
        catalogue: this.deps.items.size,
        items: matches.slice(0, limit).map((template) => ({
          ...itemRow(template),
          // The ✎ mark. A row, not the whole record — the panel shows *that* it is authored here and
          // *what* is authored in the editor, the same split the zones browser keeps.
          ...(this.deps.live.itemOverrides().has(template.vnum) ? { edited: true } : {}),
          // A6b's own mark, and a *different* one: edited means a harvested item with changes over it,
          // created means there is no harvest under it at all. Conflating them would put `Restore
          // harvested` on a row with nothing to restore.
          ...(this.deps.live.authoredItems().has(template.vnum) ? { created: true } : {}),
        })),
      },
    };
  }

  /**
   * `GET /art` — the indexed LPC sheets, optionally filtered to a slot.
   *
   * Read straight from the generated module rather than the filesystem: the index and the staged PNGs
   * are produced by one pass, so anything listed here has a sheet behind it by construction. The slot
   * filter is what lets the editor show boots when the operator is editing boots — a hint from
   * `artgen`'s own type mapping, and not enforced anywhere, because somebody will eventually want a
   * hat sheet on a helmet-shaped shield and that is their business.
   */
  private art(query: Readonly<Record<string, string>> | undefined): AdminResponse {
    const slot = (query?.['slot'] ?? '').trim();
    const term = (query?.['q'] ?? '').trim().toLowerCase();
    const matches = LPC_ART.filter(
      (a) =>
        (!slot || a.slot === slot) &&
        (!term || a.id.includes(term) || a.name.toLowerCase().includes(term) || a.kind.includes(term)),
    );
    return { status: 200, body: { total: LPC_ART.length, art: matches } };
  }

  /* ------------------------------------------------------------------------ */
  /* A4 — zones and mobs, live                                                 */
  /* ------------------------------------------------------------------------ */

  /** `GET /zones/:id/mobs` — what is standing in the zone this instant, not what it is authored to hold. */
  private zoneMobs(slug: string): AdminResponse {
    const zone = Number(slug);
    if (!Number.isInteger(zone) || !this.deps.world.zone(zone)) {
      return { status: 404, body: { error: `no zone ${slug} in the loaded world` } };
    }
    const mobs = this.deps.live.mobsIn(zone);
    return { status: 200, body: { zone, total: mobs.length, mobs } };
  }

  /**
   * `POST /zones/:id/repop` — run the reset now.
   *
   * **Audited like every other mutation, and announced to nobody.** A repop is not a message: things
   * appear where they appear and whoever is standing there is told by the ordinary presence path. An
   * operator announcement would be telling the world that the world was edited.
   */
  private repop(slug: string): AdminResponse {
    const zone = Number(slug);
    if (!Number.isInteger(zone) || !this.deps.world.zone(zone)) {
      return { status: 404, body: { error: `no zone ${slug} in the loaded world` } };
    }
    const outcome = this.deps.live.repopZone(zone);
    if (!outcome) {
      // A refusal with the reason, not a silent zero: a zone with no population file will *never*
      // repop, and "0 mobs appeared" reads as a bug in the button rather than a fact about the zone.
      return { status: 409, body: { error: `zone ${zone} has no population file — it is geometry only` } };
    }
    this.audit('zone.repop', { zone, ...outcome });
    return { status: 200, body: { ok: true, zone, ...outcome } };
  }

  /**
   * `GET /mobs?q=` — the harvested templates, searched.
   *
   * Same shape as the item catalogue's search and for the same reason: it is a list nobody should be
   * asked to scroll. Matched on the authored keyword list and the name with colour stripped, exactly
   * as `itemMatches` does, because a mob's name carries the builder's codes too.
   */
  private mobs(query: Readonly<Record<string, string>> | undefined): AdminResponse {
    const term = (query?.['q'] ?? '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(query?.['limit'] ?? 50) || 50));
    const all = this.deps.live.mobTemplates();
    const matches = all.filter(
      (m) =>
        !term ||
        String(m.vnum) === term ||
        m.keywords.some((w) => w.toLowerCase().includes(term)) ||
        stripColour(m.name).toLowerCase().includes(term),
    );
    // A4c: what each row is authored to carry, folded in here rather than fetched per row. The panel
    // needs it to mark a template and to open its editor with something in it, and a request per row
    // would be fifty requests to answer a question the server already has in a map.
    const overrides = this.deps.live.mobOverrides();
    const rows = matches.slice(0, limit).map((template) => {
      const override = overrides.get(template.vnum);
      const loot = override?.loot;
      // A9. **Which fields, not merely that there are some** — the same thing the Items row does with its
      // ✎ mark: *that* it is authored belongs on the row, *what* is authored belongs in the editor, and a
      // row that says `level, hp` is the difference between "somebody touched this" and a reason to open it.
      const edited = Object.keys(override ?? {}).filter((k) => k !== 'at' && k !== 'by' && k !== 'loot');
      const marks = {
        ...(edited.length > 0 ? { edited } : {}),
        // A9b. ✦ rather than ✎: *made here* and *edited* are different facts, and a created mob has no
        // harvest a re-run could restore — which is what its editor's dangerous button has to say.
        ...(this.deps.live.authoredMobs().mobs.has(template.vnum) ? { created: true } : {}),
      };
      if (!loot || loot.length === 0) return { ...template, ...marks };
      // **Named here, because only this side has the catalogue.** The overlay stores vnums — that is
      // the join key and the only thing that should be persisted — but an editor listing `item 2749`
      // twice is an editor nobody can check their own work in. The name is decoration on the way out
      // and is never read back.
      return {
        ...template,
        ...marks,
        loot: loot.map((row) => ({ ...row, name: this.deps.items.get(row.vnum)?.name ?? `item ${row.vnum}` })),
      };
    });
    return { status: 200, body: { total: matches.length, catalogue: all.length, mobs: rows } };
  }

  /** `POST /mobs` — put one instance of a template in a room. */
  private spawnMob(body: unknown): AdminResponse {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'POST body must be a JSON object' } };
    }
    const raw = body as { vnum?: unknown; room?: unknown };
    if (typeof raw.vnum !== 'number' || !Number.isInteger(raw.vnum)) {
      return { status: 400, body: { error: 'vnum must be an integer — a mob is named by its number' } };
    }
    if (typeof raw.room !== 'number' || !Number.isInteger(raw.room)) {
      return { status: 400, body: { error: 'room must be a room id' } };
    }
    const located = this.deps.world.locate(raw.room as RoomId);
    if (!located) return { status: 404, body: { error: `no room ${raw.room} in the loaded world` } };

    const made = this.deps.live.spawnMob(raw.vnum, raw.room as RoomId);
    if ('error' in made) return { status: 400, body: { error: made.error } };
    this.audit('mob.spawn', { vnum: raw.vnum, room: raw.room, id: made.id });
    return { status: 201, body: { ok: true, ...made, room: raw.room } };
  }

  /** `DELETE /mobs/:id` — kill one live instance, through the game's own death path. */
  private slayMob(slug: string): AdminResponse {
    const id = Number(slug);
    if (!Number.isInteger(id)) return { status: 400, body: { error: `"${slug}" is not an entity id` } };
    const slain = this.deps.live.slayMob(id);
    // 404 rather than 409: an id that named a mob a second ago and does not now is a thing that
    // *died*, and the panel's list is simply stale. Saying "gone" is the truthful answer to both.
    if (!slain) return { status: 404, body: { error: `no live mob with entity id ${id}` } };
    this.audit('mob.slay', { id, name: stripColour(slain.name) });
    return { status: 200, body: { ok: true, ...slain } };
  }

  /**
   * `POST /rooms/:id/door` — open, shut or lock a doorway.
   *
   * `closed` and `locked` are independent and both optional, because they are independent in the
   * world: `LOCKS_HOLD` is off, so a locked door still opens, and an operator testing the day it goes
   * on needs to be able to set them apart. Sending neither is refused rather than treated as a no-op,
   * for the reason `authorItem` refuses an empty patch — a request that changes nothing and reports
   * success is indistinguishable from one that failed.
   */
  private workDoor(slug: string, body: unknown): AdminResponse {
    const room = Number(slug);
    if (!Number.isInteger(room)) return { status: 400, body: { error: `"${slug}" is not a room id` } };
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'POST body must be a JSON object' } };
    }
    const raw = body as { dir?: unknown; closed?: unknown; locked?: unknown };
    if (typeof raw.dir !== 'string' || !parseDirection(raw.dir)) {
      return { status: 400, body: { error: 'dir must be a direction — north, east, south, west, up or down' } };
    }
    if (raw.closed !== undefined && typeof raw.closed !== 'boolean') {
      return { status: 400, body: { error: 'closed must be true or false' } };
    }
    if (raw.locked !== undefined && typeof raw.locked !== 'boolean') {
      return { status: 400, body: { error: 'locked must be true or false' } };
    }
    if (raw.closed === undefined && raw.locked === undefined) {
      return { status: 400, body: { error: 'send closed, locked, or both — an empty change is not a change' } };
    }

    const worked = this.deps.live.workDoor(room as RoomId, raw.dir, {
      ...(raw.closed === undefined ? {} : { closed: raw.closed }),
      ...(raw.locked === undefined ? {} : { locked: raw.locked }),
    });
    if ('error' in worked) return { status: 404, body: { error: worked.error } };
    this.audit('door.work', { room, dir: raw.dir, closed: worked.closed, locked: worked.locked });
    return { status: 200, body: { ok: true, room, dir: raw.dir, door: worked } };
  }

  /** One item, whole. The row is a summary; this is every harvested field. */
  private item(slug: string): AdminResponse {
    const vnum = Number(slug);
    const template = Number.isInteger(vnum) ? this.deps.items.get(vnum) : undefined;
    if (!template) return { status: 404, body: { error: `no item ${slug} in the catalogue` } };
    // The override rides along so the editor can show which fields are authored and which are the
    // harvest's — the ✎ mark's whole meaning, and the difference between "edit" and "re-type".
    // `created` rides along too: an item with no harvest under it gets a Delete and no Restore, and
    // the editor cannot work that out from the record alone.
    return {
      status: 200,
      body: {
        item: template,
        authored: this.deps.live.itemOverrides().get(vnum) ?? null,
        created: this.deps.live.authoredItems().get(vnum) ?? null,
      },
    };
  }

  /**
   * `PATCH /items/:vnum` — the A6 write, and the panel's Save.
   *
   * The same whole-or-nothing shape as {@link authorRoom}: every field is validated before anything is
   * applied, `null` clears a field back to the harvest, and an unknown key is refused **with the
   * reason** — `type` is behaviour, not content, and the message says so rather than leaving an
   * operator to wonder which spelling would have worked. `slot` and `weaponClass` crossed to the
   * authorable side on the owner's rulings (2026-08-07): the shroud that belongs on the back, and
   * the scimitar that punched.
   */
  private authorItem(slug: string, body: unknown): AdminResponse {
    const vnum = Number(slug);
    if (!Number.isInteger(vnum)) return { status: 400, body: { error: `"${slug}" is not an item vnum` } };
    if (!this.deps.items.has(vnum)) return { status: 404, body: { error: `no item ${vnum} in the catalogue` } };

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'PATCH body must be a JSON object' } };
    }

    // **One Save for both kinds of item, and the *server* decides which it is.** A created item has no
    // harvest to patch, so an edit to one is a re-draft of the whole record — a different store, a
    // different validator, and no `Restore harvested` because there is nothing behind it. Dispatching
    // here rather than in the panel means the front end has one route to call and cannot get the
    // choice wrong; the vnum range is the discriminator, exactly as it is on disk.
    if (vnum >= AUTHORED_VNUM_BASE) return this.reauthorItem(vnum, body as Record<string, unknown>);
    const patch = body as Record<string, unknown>;
    const keys = Object.keys(patch);
    if (keys.length === 0) return { status: 400, body: { error: 'empty patch' } };
    for (const key of keys) {
      if (!ITEM_PATCH_KEYS.has(key)) {
        return {
          status: 400,
          body: {
            error:
              `"${key}" is not authorable — one of: ${[...ITEM_PATCH_KEYS].join(', ')}. ` +
              `An item's type, container rule and stacking are behaviour derived from the ` +
              `source's own bits, not content.`,
          },
        };
      }
    }

    // Validated whole before anything is written, so an edit either lands or does not. A mutable
    // local rather than `Partial<ItemOverride>`, whose fields are readonly — same shape `authorRoom`
    // builds for the same reason.
    const next: {
      name?: string;
      keywords?: readonly string[];
      ac?: number;
      damage?: Dice;
      cost?: number;
      art?: string;
      light?: { readonly radius: number; readonly durationMs?: number };
      slot?: EquipSlot;
      weaponClass?: number;
      by?: string;
    } = {};
    const cleared: string[] = [];

    if (patch.name !== undefined) {
      if (patch.name === null) cleared.push('name');
      else if (typeof patch.name !== 'string' || !patch.name.trim()) {
        return { status: 400, body: { error: 'name must be a non-empty string, or null to unauthor it' } };
      } else if (patch.name.length > ITEM_NAME_MAX) {
        return { status: 400, body: { error: `name must be at most ${ITEM_NAME_MAX} characters` } };
      } else next.name = patch.name.trim();
    }
    if (patch.keywords !== undefined) {
      if (patch.keywords === null) cleared.push('keywords');
      else if (!Array.isArray(patch.keywords)) {
        return { status: 400, body: { error: 'keywords must be an array of words, or null' } };
      } else {
        const words = (patch.keywords as unknown[])
          .filter((w): w is string => typeof w === 'string')
          .map((w) => w.trim().toLowerCase())
          .filter((w) => w.length > 0);
        if (words.length === 0 || words.length !== patch.keywords.length) {
          return { status: 400, body: { error: 'keywords must be one or more non-empty words' } };
        }
        const long = words.find((w) => w.length > ITEM_KEYWORD_MAX);
        if (long) return { status: 400, body: { error: `keyword "${long}" is over ${ITEM_KEYWORD_MAX} characters` } };
        next.keywords = [...new Set(words)];
      }
    }
    if (patch.ac !== undefined) {
      if (patch.ac === null) cleared.push('ac');
      else if (typeof patch.ac !== 'number' || !Number.isInteger(patch.ac) || patch.ac < 0 || patch.ac > ITEM_AC_MAX) {
        // The bound is ours, not Duris': this edits the compressed scale the fight actually uses,
        // where a single legendary piece caps at 8 — 50 is already outlandish and anything past it
        // is a typo with consequences.
        return { status: 400, body: { error: `ac must be an integer from 0 to ${ITEM_AC_MAX}` } };
      } else next.ac = patch.ac;
    }
    if (patch.damage !== undefined) {
      if (patch.damage === null) cleared.push('damage');
      else {
        const dice = readDice(patch.damage);
        if (!dice) {
          return { status: 400, body: { error: 'damage must be {count, sides, bonus?} within sane bounds, or null' } };
        }
        next.damage = dice;
      }
    }
    if (patch.cost !== undefined) {
      if (patch.cost === null) cleared.push('cost');
      else if (typeof patch.cost !== 'number' || !Number.isInteger(patch.cost) || patch.cost < 0) {
        return { status: 400, body: { error: 'cost must be a non-negative integer, or null' } };
      } else next.cost = patch.cost;
    }
    if (patch.art !== undefined) {
      if (patch.art === null || patch.art === '') cleared.push('art');
      else if (typeof patch.art !== 'string' || !isKnownArt(patch.art, LPC_ART_BY_ID)) {
        // Named, not merely refused: the index is generated, so a bad id is a typo or a sheet somebody
        // removed, and neither is guessable from "invalid art".
        return {
          status: 400,
          body: { error: `no such art: ${String(patch.art)}. GET /art lists what is indexed, or null to clear it` },
        };
      } else next.art = patch.art;
    }
    if (patch.light !== undefined) {
      // A6c. `null` puts the light out — which for an item the *harvest* lit means restoring the harvest,
      // and for one only the overlay lit means it stops being a light at all. Both fall out of the overlay
      // being a patch over a pristine template rather than a copy of one.
      if (patch.light === null) cleared.push('light');
      else {
        const light = readAuthoredLight(patch.light);
        if (!light) {
          // Named rather than merely refused, the rule the art error above follows: the caller sent
          // *something*, and "invalid light" would not say which half of it was wrong.
          return {
            status: 400,
            body: {
              error:
                'light must be {radius, durationMs?} with a numeric radius, or null to clear it. ' +
                `radius is clamped to 1-${MAX_AUTHORED_LIGHT_RADIUS} (every light reaches as far as a torch — ` +
                'duration is what separates a candle from a lantern), and an absent durationMs means it never goes out',
            },
          };
        }
        next.light = light;
      }
    }
    if (patch.slot !== undefined) {
      // The owner's shroud ruling (2026-08-07): where a thing is worn is authorable. Null restores
      // the harvest's own wear bits.
      if (patch.slot === null || patch.slot === '') cleared.push('slot');
      else if (typeof patch.slot !== 'string' || !(EQUIP_SLOTS as readonly string[]).includes(patch.slot)) {
        return { status: 400, body: { error: `no such slot: ${String(patch.slot)} — one of: ${EQUIP_SLOTS.join(', ')}` } };
      } else next.slot = patch.slot as EquipSlot;
    }
    if (patch.weaponClass !== undefined) {
      // Windsong's own lesson: the class is the verb, the trained skill and the swing animation in
      // one number, and a weapon without one punches.
      if (patch.weaponClass === null) cleared.push('weaponClass');
      else if (
        typeof patch.weaponClass !== 'number' ||
        !Number.isInteger(patch.weaponClass) ||
        patch.weaponClass < 1 ||
        patch.weaponClass > 20
      ) {
        return { status: 400, body: { error: 'weaponClass must be an integer from 1 to 20 (Duris’ own ladder), or null' } };
      } else next.weaponClass = patch.weaponClass;
    }
    if (patch.by !== undefined) {
      if (patch.by === null) cleared.push('by');
      else if (typeof patch.by !== 'string') return { status: 400, body: { error: 'by must be a string or null' } };
      else next.by = patch.by.slice(0, 200);
    }

    const applied = this.deps.live.authorItem(vnum, next, cleared);
    if (!applied) return { status: 404, body: { error: `no item ${vnum} in the catalogue` } };
    if (this.deps.itemOverridesFile) saveItemOverrides(this.deps.live.itemOverrides(), this.deps.itemOverridesFile);

    this.audit('item.author', { vnum, fields: keys, cleared });
    return {
      status: 200,
      body: {
        ok: true,
        item: itemRow(applied),
        authored: this.deps.live.itemOverrides().get(vnum) ?? null,
      },
    };
  }

  /**
   * `POST /items` — A6b's create.
   *
   * **The body carries no vnum and one is refused if sent.** The number is the server's to allocate
   * from the reserved range, because a caller that could choose would eventually choose one Duris also
   * uses, and a vnum collision is not a conflict anybody sees — it is two different items quietly
   * becoming one, in the catalogue, in every saved bag, and in every reset that names it.
   *
   * The validation lives in `draftAuthoredItem` rather than here, so the door a form comes through and
   * the door a hand-edited file comes through are the same door.
   */
  private createItem(body: unknown): AdminResponse {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'POST body must be a JSON object' } };
    }
    const draft = body as Record<string, unknown>;
    if (draft.vnum !== undefined) {
      return {
        status: 400,
        body: { error: 'vnum is allocated by the server — an item may not choose its own join key' },
      };
    }
    const by = typeof draft.by === 'string' ? draft.by.slice(0, 200) : 'panel';
    const created = this.deps.live.authorNewItem(undefined, draft as ItemDraft, by);
    if ('error' in created) return { status: 400, body: { error: created.error } };

    this.audit('item.create', { vnum: created.item.vnum, name: created.item.name });
    return { status: 201, body: { ok: true, vnum: created.item.vnum, item: itemRow(created.item) } };
  }

  /**
   * The created-item half of `PATCH /items/:vnum`. Reached only through {@link authorItem}'s dispatch.
   *
   * Accepts the same field names the patch path does plus the ones only a whole record has — `slot`,
   * `type`, `size` and the container rule are *refused* on a harvested item because they are derived
   * from the source's own bits, and there is no source here to disagree with.
   */
  private reauthorItem(vnum: number, patch: Record<string, unknown>): AdminResponse {
    const keys = Object.keys(patch).filter((key) => key !== 'by');
    if (keys.length === 0) return { status: 400, body: { error: 'empty patch' } };
    const by = typeof patch.by === 'string' ? patch.by.slice(0, 200) : 'panel';
    const edited = this.deps.live.authorNewItem(vnum, patch as ItemDraft, by);
    if ('error' in edited) return { status: 400, body: { error: edited.error } };

    this.audit('item.reauthor', { vnum, fields: keys });
    return { status: 200, body: { ok: true, item: itemRow(edited.item), created: true } };
  }

  /**
   * `DELETE /items/:vnum` — removes an item that was created here.
   *
   * **A harvested item cannot be deleted, and the refusal says why**: the next `npm run worldgen` would
   * put it straight back, so a delete that appeared to work would be a lie with a restart's fuse on it.
   * Retiring a Duris item is a zone edit, not a catalogue one.
   */
  private destroyItem(slug: string): AdminResponse {
    const vnum = Number(slug);
    if (!Number.isInteger(vnum)) return { status: 400, body: { error: `"${slug}" is not an item vnum` } };
    if (vnum < AUTHORED_VNUM_BASE) {
      return {
        status: 400,
        body: {
          error:
            `item ${vnum} came from the harvest and cannot be deleted — the next worldgen would ` +
            `restore it. Only items created here can be removed.`,
        },
      };
    }
    if (!this.deps.live.deleteAuthoredItem(vnum)) {
      return { status: 404, body: { error: `no item created here with vnum ${vnum}` } };
    }
    this.audit('item.delete', { vnum });
    return { status: 200, body: { ok: true } };
  }

  /**
   * `POST /zones` — **A8d, a zone from nothing**, and the three cases the roadmap said A8's rules
   * cannot express, each answered where it said to answer them:
   *
   * 1. **The id is the server's**, from {@link AUTHORED_ZONE_BASE} with the stored counter — the body
   *    may not choose one, for the reason `createItem` gives about join keys.
   * 2. **The first room is written in the same motion**, at the origin `(0,0,0)`: a zone with no
   *    rooms cannot even compose, and `composeAuthoredRooms`' origin exception is what places a room
   *    no neighbour rule can. Its extent is recorded now, so the first boot does not read the new
   *    Place as stale and write a git-tracked file for nothing.
   * 3. **Which zones load stays a file.** Nothing here touches `world.config.json` or the live world;
   *    the response says — in words, to a person — what to add and that a restart makes it real.
   *    That is the roadmap's own sizing of the honest first version, kept.
   */
  private createZone(body: unknown): AdminResponse {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'POST body must be a JSON object' } };
    }
    const draft = body as Record<string, unknown>;
    if (draft.id !== undefined) {
      return { status: 400, body: { error: 'the id is allocated by the server — a zone may not choose its own join key' } };
    }
    const name = readZoneName(draft.name);
    if (!name) {
      return { status: 400, body: { error: `name must be a non-empty string of at most ${ZONE_NAME_MAX} characters` } };
    }
    const roomName =
      typeof draft.roomName === 'string' && draft.roomName.trim() ? draft.roomName.trim() : 'An Unmade Place';
    const sector =
      typeof draft.sector === 'string' && (SECTORS as readonly string[]).includes(draft.sector)
        ? (draft.sector as Sector)
        : 'inside';
    const by = typeof draft.by === 'string' ? draft.by.slice(0, 200) : undefined;
    const at = new Date().toISOString();

    const { world } = this.deps;
    const zoneId = takeAuthoredZoneId(world.authoredZones);
    world.authoredZones.zones.set(zoneId, { name, at, ...(by ? { by } : {}) });
    if (this.deps.authoredZonesFile) saveAuthoredZones(world.authoredZones, this.deps.authoredZonesFile);

    const roomId = takeAuthoredRoomId(world.authoredRooms);
    // Through the same drafting door every other room passes — with the origin allowance, which is
    // the one loosening A8d owns. Hand-building the record here would be the second validator the
    // reader's header warns about, and the drive proved it: the first version did exactly that, and
    // the loader (running the real rules) dropped the room on the next boot.
    const drafted = draftAuthoredRoom(
      roomId,
      { zone: zoneId, name: roomName, sector, x: 0, y: 0, level: 0, exits: [] },
      { allowNoExits: true },
    );
    if ('error' in drafted) return { status: 400, body: { error: drafted.error } };
    world.authoredRooms.rooms.set(roomId, { room: drafted.room, at, ...(by ? { by } : {}) });
    world.authoredRooms.extents.set(placeKey({ zone: zoneId, level: 0 }), { minX: 0, maxX: 0, minY: 0, maxY: 0 });
    if (this.deps.authoredRoomsFile) saveAuthoredRooms(world.authoredRooms, this.deps.authoredRoomsFile);

    this.audit('zone.create', { zone: zoneId, name, room: roomId });
    return {
      status: 201,
      body: {
        ok: true,
        zone: zoneId,
        room: roomId,
        note:
          `zone ${zoneId} "${name}" is written but not loaded: add ${zoneId} to "zones" in ` +
          `world.config.json and restart the server. Its first room, ${roomId} "${roomName}", stands at ` +
          `the origin — teleport to it and build outward with the ordinary room tools. Nothing links to ` +
          `it yet: an authored zone starts as an island.`,
      },
    };
  }

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
    // A8d: created zones the config does not load yet. Shown so a creation is not invisible until a
    // restart — the row a person just made must appear *somewhere*, and the note says why it is here.
    const loaded = new Set(world.allZones().map((zone) => zone.id));
    const pending = [...world.authoredZones.zones.entries()]
      .filter(([id]) => !loaded.has(id))
      .map(([id, zone]) => ({ id, name: zone.name, note: 'add to world.config.json and restart' }));
    return {
      status: 200,
      body: {
        ...(pending.length > 0 ? { pending } : {}),
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
        // A8 slice 3. **Answered here because only the server can**, and the panel needs it *before*
        // the operator presses anything — a warning that arrives with the response is a warning
        // about something that has already happened. True when this room is the last one holding
        // one of its level's four bounds, so removing it would move the corner every saved tile
        // index is measured from.
        holdsExtent: narrowsExtent(this.deps.world.zone(room.zone)?.rooms ?? [], room.id),
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

  /**
   * Every account: who they are, what they hold, when they last came by. Read-only, and it never
   * ships a hash — the list exists so the operator can find the slug the two writes below want.
   */
  private accounts(): AdminResponse {
    const accounts = this.deps.accounts.all().map((account) => ({
      slug: account.slug,
      name: account.name,
      characters: account.characters,
      createdAt: account.createdAt,
      lastSeen: account.lastSeen ?? null,
    }));
    return { status: 200, body: { accounts } };
  }

  /** The operator-mediated reset — the whole of the "forgot my password" story, on purpose. */
  private resetPassword(slug: string, body: unknown): AdminResponse {
    const raw = asRecord(body);
    if (!raw || typeof raw['password'] !== 'string') {
      return { status: 400, body: { error: 'body must be { password }' } };
    }
    const outcome = this.deps.accounts.setPassword(slug, raw['password']);
    if (!outcome.ok) {
      const missing = outcome.reason === 'no such account';
      return { status: missing ? 404 : 400, body: { error: outcome.reason } };
    }
    // The slug and nothing else: an audit line that recorded the password would *be* the breach.
    this.audit('account.password', { slug });
    return { status: 200, body: { ok: true } };
  }

  /**
   * Assign an unowned character to an account — the post-bind claim path (DESIGN-accounts.md §6:
   * once the bind opens, flotsam is not enterable remotely, and this is how it finds an owner).
   * Someone else's character is refused here exactly as at `enter`; moving a character *between*
   * accounts is a release mechanism nobody has needed yet.
   */
  private assignCharacter(slug: string, body: unknown): AdminResponse {
    const raw = asRecord(body);
    if (!raw || typeof raw['character'] !== 'string') {
      return { status: 400, body: { error: 'body must be { character }' } };
    }
    const character = slugify(raw['character']);
    if (!character) return { status: 400, body: { error: 'that name cannot be used' } };
    const outcome = this.deps.accounts.claim(slug, character);
    if (!outcome.ok) {
      const missing = outcome.reason === 'no such account';
      return { status: missing ? 404 : 409, body: { error: outcome.reason } };
    }
    this.audit('account.claim', { slug, character });
    return { status: 200, body: { ok: true } };
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
   * `POST /items/:vnum/colour` — **A7f**, a colour proposed from the item's own description.
   *
   * Owner's ask, 2026-08-05: *"it would be great if we can have ollama do the edits based on the
   * description."* What a model can actually do here is pick one of a closed list of ramp names, which
   * `artcolour.ts` explains — and it is asked **only when the item's own name does not already say**,
   * which is the majority of the interesting cases and costs no round trip at all.
   *
   * **Suggests and writes nothing.** §8's rule, the same one room prose keeps: the answer lands in the
   * picker's dropdown, and the ordinary `PATCH /items/:vnum` is what commits it. A model that saved
   * would put unreviewed colour on the world and make *not* keeping it the expensive path.
   *
   * `model` is optional here where `describe` requires it — the deterministic half needs no model, so
   * asking for one up front would make the cheap path impossible to reach with Ollama uninstalled.
   */
  private async suggestItemColour(slug: string, body: unknown): Promise<AdminResponse> {
    const vnum = Number(slug);
    if (!Number.isInteger(vnum)) return { status: 400, body: { error: `"${slug}" is not an item vnum` } };
    const item = this.deps.items.get(vnum);
    if (!item) return { status: 404, body: { error: `no item ${vnum} in the catalogue` } };
    if (!item.art) {
      return { status: 400, body: { error: 'give it art first — a colour is a ramp of the art it wears' } };
    }
    const entry = LPC_ART_BY_ID.get(parseArtId(item.art).id);
    if (!entry?.recolours) {
      return { status: 400, body: { error: `${item.art} cannot be recoloured — its sheet declares no palettes` } };
    }

    const model = typeof (body as { model?: unknown })?.model === 'string'
      ? ((body as { model: string }).model).trim()
      : undefined;
    const suggestion = await suggestColour(
      { name: item.name, keywords: item.keywords },
      entry.recolours.ramps,
      model
        ? async (prompt) => {
            const answer = await askOnce(model, prompt);
            return answer.ok ? answer.text : undefined;
          }
        : undefined,
    );

    if (!suggestion) {
      // 200 rather than 404: *nothing suggests itself* is a real answer about this item, not a failure
      // of the route, and the panel says so rather than showing an error where a colour belongs.
      return {
        status: 200,
        body: {
          ok: true,
          ramp: null,
          reason: model
            ? 'neither the name nor the model matched a ramp this art offers'
            : 'the name names no colour — pick a model to ask, or choose one by hand',
        },
      };
    }

    this.audit('item.colour', { vnum, ramp: suggestion.ramp, how: suggestion.how });
    return {
      status: 200,
      body: {
        ok: true,
        ramp: suggestion.ramp,
        // **Which half answered**, because *the builder's own name said black* deserves more trust than
        // a model's guess, and an operator reviewing a hundred of these wants to know which is which.
        how: suggestion.how,
        ...(suggestion.because ? { because: suggestion.because } : {}),
        art: formatArtId(parseArtId(item.art).id, suggestion.ramp),
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
      nearby: this.promptNeighbours(room),
      samples: this.styleSamples(room),
    });

    if (!result.ok) {
      // 502, not 500: the failure is a service this server talks to, and the distinction matters to
      // whoever reads it — the panel is fine, the model is not.
      return { status: 502, body: { error: result.error } };
    }
    this.audit('room.draft', {
      room: id,
      model: result.model,
      brief: brief.trim(),
      ms: result.ms,
      ...(result.retriedFor.length > 0 ? { redrafted: result.retriedFor } : {}),
    });
    return {
      status: 200,
      body: {
        description: result.description,
        model: result.model,
        brief: brief.trim(),
        ms: result.ms,
        // Surfaced rather than swallowed: a draft that had to be asked twice is one worth reading
        // more carefully, and it is also the signal that would tell you a model is a poor fit here.
        retriedFor: result.retriedFor,
      },
    };
  }

  /**
   * The neighbours the *model* is shown — **named always, quoted only when a human wrote them.**
   *
   * ## The copy cascade this exists to stop
   *
   * Measured, on a per-room pass over The Stump Bog's 93 rooms: **all 37 rooms called "The Stump Bog
   * (Water)" came out word-for-word identical**, adjacent and non-adjacent alike, and 46 of 60
   * adjacent same-title pairs were over 95% the same. Not sampling convergence — a photocopier.
   *
   * The mechanism is this function's own input. Each room was shown its neighbours' prose under
   * *"stay consistent with these"*, and in a zone being filled room by room those neighbours had just
   * been written **by the same model minutes earlier**. It copied them, and the text propagated
   * outward from the first room until it had saturated the zone. A two-room pilot missed it entirely
   * because the zone was empty then: with no described neighbours the same pair diverged properly.
   *
   * ## Why the fix is not "drop the neighbours"
   *
   * The neighbours are what tie a room to where it stands, and that demonstrably works — a room
   * beside the Gigantic Duskwood wrote about duskwood while one beside three oaks wrote about oaks.
   * But re-reading that result: it was the neighbour's **name** carrying the information, not its
   * prose. So the name always goes, and the prose goes only when it is not the model's own output
   * coming back around.
   *
   * The test is `by`, recorded in the overlay at the moment a draft is saved — so:
   *
   * - **harvested** prose (the Duris builders' own) — quoted; it is the house style and the point.
   * - **hand-written** prose (somebody typed it) — quoted; a person's writing is worth matching.
   * - **model-written** prose — named only. This is the loop, and it is the only case cut.
   *
   * Neighbours with usable prose are preferred when trimming to {@link NEARBY_IN_PROMPT}, so cutting
   * the loop costs context only when there is no human-written context to be had.
   */
  private promptNeighbours(room: Room): readonly { name: string; description?: string; dir: string | null }[] {
    const machineWrote = (id: number): boolean => this.deps.world.overrides.get(id as RoomId)?.by !== undefined;

    const all = this.neighbourhood(room).map((near) => ({
      name: near.name,
      dir: near.dir,
      ...(near.description && !machineWrote(near.id) ? { description: near.description } : {}),
    }));
    // Quotable first, so the trim keeps the neighbours that can actually teach something.
    return all
      .sort((a, b) => Number(Boolean(b.description)) - Number(Boolean(a.description)))
      .slice(0, NEARBY_IN_PROMPT);
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
    // **Machine-written rooms are excluded, and this is the stronger half of the cascade fix.**
    // The block these feed is headed *"match the voice, rhythm and level of detail of the EXAMPLES
    // exactly"* — the most direct copy instruction in the prompt. Once a zone had been filled, its
    // rooms became the nearest-sector samples for the next zone, and the model was being told to
    // match its own output exactly. The Stump Bog's swamp samples were the Stag Forest's swamp
    // rooms, every one of them written an hour earlier by the same model.
    //
    // Falling back to a further-away *human* sample beats an exactly-matching machine one: the whole
    // purpose of few-shot here is to transmit the Duris builders' voice, and a copy of a copy
    // transmits drift instead. See `promptNeighbours` for the other half.
    const described = this.deps.world
      .allZones()
      .flatMap((zone) => zone.rooms)
      .filter(
        (candidate) =>
          candidate.description &&
          candidate.id !== room.id &&
          this.deps.world.overrides.get(candidate.id)?.by === undefined,
      );
    if (described.length === 0) return [];

    // **Sector outranks zone**, and the Stag Forest is why. It has prose for 0 of 98 rooms, so
    // "sample the same zone" returns nothing and every room in it would be written with no examples
    // at all. Widening to the whole loaded world finds 24 described forest rooms and 7 roads — in
    // IceCrag, but outdoors and in the right register. Where they conflict, sector wins: showing a
    // model three stone corridors while asking it for a forest is actively harmful, whereas showing
    // it a forest another builder wrote is merely second best. Same zone still breaks the tie.
    const tier = (candidate: Room): number =>
      (candidate.sector === room.sector ? 2 : 0) + (candidate.zone === room.zone ? 1 : 0);
    const best = Math.max(...described.map(tier));
    const pool = described.filter((candidate) => tier(candidate) === best);

    // Spread through the pool rather than taking the first three, which would be three rooms from
    // the same corridor — and deterministic, so pressing the button twice varies by the model's own
    // sampling rather than by which examples it happened to get.
    const step = Math.max(1, Math.floor(pool.length / SAMPLE_COUNT));
    const picked: Room[] = [];
    for (let i = 0; i < pool.length && picked.length < SAMPLE_COUNT; i += step) picked.push(pool[i]!);
    // Longest first: a 51-word room demonstrates less of the voice than a 130-word one, and the
    // median is 115.
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

    const read = this.readRoomPatch(body);
    if ('refused' in read) return read.refused;
    const { next, cleared, keys } = read;

    // **One Save for both kinds of room, and the *server* decides which it is.** A created room has
    // no harvest to patch, so an edit to one rewrites its own record in the other overlay — A6b's
    // dispatch, and the id range is the discriminator here exactly as it is on disk. The panel calls
    // one route and cannot get the choice wrong.
    if (this.deps.world.isAuthoredRoom(id as RoomId)) {
      return this.reauthorRoom(id as RoomId, next, cleared, keys);
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

  /**
   * The four fields a builder writes, validated whole before any of them is applied.
   *
   * Split out when A8 gave the same patch a second destination: a created room's edit lands in
   * `rooms-authored.json` and a harvested room's in `rooms.json`, and validating the body twice is
   * how one of them quietly starts accepting a flag the other rejects.
   *
   * `null` is how a field is *unauthored*, and it is not the same as `""` — see {@link authorRoom}.
   */
  private readRoomPatch(
    body: unknown,
  ):
    | { readonly next: RoomOverride; readonly cleared: string[]; readonly keys: string[] }
    | { readonly refused: AdminResponse } {
    const refuse = (error: string) => ({ refused: { status: 400, body: { error } } } as const);

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return refuse('PATCH body must be a JSON object');
    }
    const patch = body as Record<string, unknown>;
    const keys = Object.keys(patch);
    if (keys.length === 0) return refuse('empty patch');
    for (const key of keys) {
      if (!ROOM_PATCH_KEYS.has(key)) {
        return refuse(
          `"${key}" is not authorable — one of: ${[...ROOM_PATCH_KEYS].join(', ')}. ` +
            `A room's id, position and exits are geometry, not content.`,
        );
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
      else if (typeof value !== 'string') return refuse(`${key} must be a string or null`);
      else next[key as 'by' | 'brief'] = value.slice(0, BRIEF_MAX);
    }

    if (patch.name !== undefined) {
      if (patch.name === null) cleared.push('name');
      else if (typeof patch.name !== 'string' || !patch.name.trim()) {
        return refuse('name must be a non-empty string, or null to unauthor it');
      } else if (patch.name.length > ROOM_NAME_MAX) {
        return refuse(`name must be at most ${ROOM_NAME_MAX} characters`);
      } else next.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      if (patch.description === null) cleared.push('description');
      else if (typeof patch.description !== 'string') {
        return refuse('description must be a string, or null to unauthor it');
      } else if (patch.description.length > ROOM_PROSE_MAX) {
        return refuse(`description must be at most ${ROOM_PROSE_MAX} characters`);
      } else next.description = patch.description;
    }
    if (patch.sector !== undefined) {
      if (patch.sector === null) cleared.push('sector');
      else if (typeof patch.sector !== 'string' || !(SECTORS as readonly string[]).includes(patch.sector)) {
        return refuse(`sector must be one of: ${SECTORS.join(', ')}`);
      } else next.sector = patch.sector as Sector;
    }
    if (patch.flags !== undefined) {
      if (patch.flags === null) cleared.push('flags');
      else if (!Array.isArray(patch.flags)) {
        return refuse('flags must be an array');
      } else {
        const bad = patch.flags.filter((f) => typeof f !== 'string' || !(ROOM_FLAGS as readonly string[]).includes(f));
        if (bad.length > 0) {
          return refuse(`unknown flags ${JSON.stringify(bad)} — one of: ${ROOM_FLAGS.join(', ')}`);
        }
        next.flags = [...new Set(patch.flags as RoomFlag[])];
      }
    }

    return { next, cleared, keys };
  }

  /**
   * Rewrites a created room's own record — the other half of {@link authorRoom}'s dispatch.
   *
   * **`null` is refused here, and that is the difference between the two overlays in one line.** On a
   * harvested room null means *unauthor*: drop the override and let the generated value show through.
   * Under a created room there is nothing to show through, so the same request would either blank a
   * field the room must have or delete an entry that is the room. A6b's table, third row.
   */
  private reauthorRoom(id: RoomId, next: RoomOverride, cleared: readonly string[], keys: readonly string[]): AdminResponse {
    if (cleared.length > 0) {
      return {
        status: 400,
        body: {
          error:
            `room ${id} was created here, so ${cleared.join(', ')} cannot be unauthored — there is no ` +
            `harvested room underneath it to restore. Write the field instead.`,
        },
      };
    }

    const before = this.deps.world.locate(id)?.room.sector;
    const applied = this.deps.world.reauthorRoom(id, next, new Date().toISOString());
    if (!applied) return { status: 404, body: { error: `no room ${id} created here` } };
    if (this.deps.authoredRoomsFile) {
      saveAuthoredRooms(this.deps.world.authoredRooms, this.deps.authoredRoomsFile);
    }

    const regrid = applied.room.sector !== before;
    if (regrid) this.deps.world.dropGrid(applied.place);
    this.deps.live.publishRoom(applied.room, applied.place, regrid);

    this.audit('room.reauthor', { room: id, fields: keys, regrid });
    return {
      status: 200,
      body: {
        ok: true,
        room: { id: applied.room.id, name: applied.room.name, sector: applied.room.sector },
        regrid,
        created: true,
      },
    };
  }

  /**
   * Builds a room in a gap the source left — A8's first slice, and its whole write surface.
   *
   * **Refusals are 409 rather than 400 when the world is what said no.** A malformed draft is the
   * request's fault; a cell already occupied, an extent that does not reach, or a neighbour whose exit
   * is already spoken for are all facts about the zone that were true before the request arrived and
   * that an operator fixes by picking a different cell. Telling the two apart is what lets the panel
   * say *"try somewhere else"* rather than *"you typed it wrong"*.
   *
   * The id is allocated inside `GameWorld.createRoom`, once the room is certain — so the base is
   * passed here only to satisfy the draft validator's own range rule, and is replaced. That is worth
   * saying out loud because the alternative reads fine and is wrong: allocating first and validating
   * after burns a number on every rejected form submission.
   */
  private createRoom(slug: string, body: unknown): AdminResponse {
    const zoneId = Number(slug);
    if (!Number.isInteger(zoneId)) return { status: 400, body: { error: `"${slug}" is not a zone id` } };
    if (!this.deps.world.zone(zoneId as ZoneId)) {
      return { status: 404, body: { error: `zone ${zoneId} is not loaded` } };
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'POST body must be a JSON object' } };
    }
    const draft = body as Record<string, unknown>;

    const drafted = draftAuthoredRoom(AUTHORED_ROOM_BASE, { ...draft, zone: zoneId });
    if ('error' in drafted) return { status: 400, body: { error: drafted.error } };

    const by = typeof draft.by === 'string' ? draft.by.slice(0, BRIEF_MAX) : undefined;
    const brief = typeof draft.brief === 'string' ? draft.brief.slice(0, BRIEF_MAX) : undefined;
    const created = this.deps.world.createRoom(zoneId as ZoneId, drafted, {
      at: new Date().toISOString(),
      ...(by ? { by } : {}),
      ...(brief ? { brief } : {}),
    });
    if ('error' in created) return { status: 409, body: { error: created.error } };

    // **The invalidation before the save**, so the overlay never records an extent whose maps are
    // still keyed to the old one. `recordExtent` is what the next boot compares against, and writing
    // it early would make a failed clearing invisible for ever.
    const forgot = created.extentChanged ? this.deps.live.forgetPlace(created.place) : undefined;
    if (created.extentChanged) this.deps.world.recordExtent(created.place);

    if (this.deps.authoredRoomsFile) {
      saveAuthoredRooms(this.deps.world.authoredRooms, this.deps.authoredRoomsFile);
    }
    // Always a regrid: the room is a new block of floor on a grid that was carved without it, and
    // every client standing on this Place is holding the old one.
    this.deps.live.publishRoom(created.room, created.place, true);

    this.audit('room.create', {
      room: created.room.id,
      zone: zoneId,
      pos: created.room.pos,
      exits: Object.keys(created.room.exits),
      extentChanged: created.extentChanged,
      ...(forgot ? { mapsCleared: forgot.characters, told: forgot.told } : {}),
    });
    return {
      status: 200,
      body: {
        ok: true,
        room: {
          id: created.room.id,
          name: created.room.name,
          sector: created.room.sector,
          x: created.room.pos.x,
          y: created.room.pos.y,
          level: created.room.pos.z,
          exits: Object.entries(created.room.exits).map(([dir, exit]) => ({ dir, to: exit.to })),
        },
        /** Whether this moved the grid, and so cost everyone their explored map here — slice 3. */
        extentChanged: created.extentChanged,
        ...(forgot ? { mapsCleared: forgot.characters, told: forgot.told } : {}),
      },
    };
  }

  /**
   * Takes a room out of the world — A8 slice 2, and the half that can destroy something.
   *
   * **Three refusals before anything moves, and each is a different kind of wrong.** The extent is
   * `GameWorld.deleteRoom`'s to protect, because narrowing a grid shifts every saved tile index. The
   * other two are here because they are about the *world in use* rather than its geometry: the spawn
   * room is where every new character arrives, so deleting it breaks joining for everybody; and a room
   * somebody is standing in cannot go, because the alternative is a player whose `roomId` resolves to
   * nothing. The operator has `teleport` and `kick` for that, and naming who is in the way is a better
   * answer than moving them without telling them.
   *
   * **What it reports is the point of the slice.** Orphaned exits and orphaned reset commands are both
   * *tolerated* rather than repaired — the shipped world already has 5 dangling exits and `reset.ts`
   * has always skipped what it cannot place — which means neither will ever announce itself again.
   * This response is the only moment anybody is told, so it says both, plus what was cleared out of
   * the room on the way.
   */
  private deleteRoom(slug: string): AdminResponse {
    const id = Number(slug);
    if (!Number.isInteger(id)) return { status: 400, body: { error: `"${slug}" is not a room id` } };
    const located = this.deps.world.locate(id as RoomId);
    if (!located) return { status: 404, body: { error: `no room ${id} in the loaded world` } };

    if (this.deps.world.spawnRoom().id === id) {
      return {
        status: 409,
        body: {
          error:
            `room ${id} is where new characters arrive — move the spawn in world.config.json first, ` +
            `or joining breaks for everybody`,
        },
      };
    }

    const here = this.deps.live.occupantsOf(id as RoomId);
    if (here.players.length > 0) {
      return {
        status: 409,
        body: {
          error:
            `${here.players.join(', ')} ${here.players.length === 1 ? 'is' : 'are'} standing in room ` +
            `${id} — teleport or kick them first`,
        },
      };
    }

    // Counted *before* the delete, so the report is assembled from a world that still makes sense.
    const resets = this.deps.live.resetsNaming(id as RoomId);

    const removed = this.deps.world.deleteRoom(id as RoomId);
    if ('error' in removed) return { status: 409, body: { error: removed.error } };

    // Only once the world has actually accepted it: clearing first would empty a room that a refusal
    // then left standing, which is a mob despawned for nothing.
    const cleared = this.deps.live.clearRoom(id as RoomId);
    // Slice 3, and the same order the additive half keeps: invalidate, then record the extent the
    // maps are now keyed to, then save.
    const forgot = removed.extentChanged ? this.deps.live.forgetPlace(removed.place) : undefined;
    if (removed.extentChanged) this.deps.world.recordExtent(removed.place);

    if (this.deps.authoredRoomsFile) {
      saveAuthoredRooms(this.deps.world.authoredRooms, this.deps.authoredRoomsFile);
    }
    // **Only when an A5 override actually went with it.** `rooms.json` is 200 KB of git-tracked
    // authored prose and rewriting it reorders every key, so a delete that touched none of it would
    // otherwise land as a few hundred lines of diff containing no change.
    if (removed.droppedOverride && this.deps.overridesFile) {
      saveRoomOverrides(this.deps.world.overrides, this.deps.overridesFile);
    }
    // Always a regrid: the floor this room stood on has to stop being floor for everyone on the Place.
    this.deps.live.publishRoom(removed.room, removed.place, true);

    const orphanedResets = Object.values(resets).reduce((sum, n) => sum + n, 0);
    this.audit('room.delete', {
      room: id,
      zone: removed.place.zone,
      orphanedExits: removed.orphans.length,
      orphanedResets,
      cleared,
      extentChanged: removed.extentChanged,
      ...(forgot ? { mapsCleared: forgot.characters, told: forgot.told } : {}),
    });
    return {
      status: 200,
      body: {
        ok: true,
        room: { id, name: removed.room.name },
        /** Exits the harvest wrote that now lead nowhere. Left alone on purpose — see decision 3. */
        orphans: removed.orphans,
        /** Reset commands that will be skipped in silence from now on — decision 4. */
        resets,
        orphanedResets,
        cleared,
        /** Whether the grid moved, and so cost everyone their explored map here — slice 3. */
        extentChanged: removed.extentChanged,
        ...(forgot ? { mapsCleared: forgot.characters, told: forgot.told } : {}),
      },
    };
  }


  /**
   * `PATCH /mobs/:vnum/loot` — what every instance of a template carries. **A4c.**
   *
   * Owner's ask (2026-08-04): *"assign items to mobs as loot."* A4 gave an operator live mobs to spawn,
   * watch and slay; this is the half that decides what is on them when they arrive.
   *
   * **Per template, and the response says so.** A harvested kit comes from the zone's reset table,
   * where an `E` attaches to the last mobile loaded — so the same vnum in two rooms can be carrying two
   * different things. This is the other kind of fact, and it is the surprising one: authoring it
   * changes every kobold guard the world spawns, and none of the ninety already standing there. The
   * body reports `spawned`, which is how many are walking around unaffected, because that number is the
   * difference between "nothing happened" and "nothing has happened *yet*".
   *
   * A vnum the catalogue does not have is refused by name rather than stored and skipped: an authored
   * piece that silently never appears is indistinguishable from the feature not working.
   */
  private authorMobLoot(slug: string, body: unknown): AdminResponse {
    const vnum = Number(slug);
    if (!Number.isInteger(vnum)) return { status: 400, body: { error: `"${slug}" is not a mob vnum` } };
    if (!this.deps.live.mobTemplates().some((template) => template.vnum === vnum)) {
      return { status: 404, body: { error: `no mob ${vnum} among the loaded templates` } };
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'PATCH body must be a JSON object' } };
    }
    const raw = (body as { loot?: unknown }).loot;
    if (!Array.isArray(raw)) return { status: 400, body: { error: 'body must be {"loot": [...]}' } };
    if (raw.length > MAX_AUTHORED_LOOT) {
      return { status: 400, body: { error: `at most ${MAX_AUTHORED_LOOT} pieces` } };
    }

    // Validated whole before anything is written, so an edit either lands or does not.
    const loot: AuthoredLoot[] = [];
    for (const entry of raw as unknown[]) {
      if (typeof entry !== 'object' || entry === null) {
        return { status: 400, body: { error: 'each piece must be {"vnum": <integer>, "slot": <slot|null>}' } };
      }
      const row = entry as { vnum?: unknown; slot?: unknown; percent?: unknown };
      if (typeof row.vnum !== 'number' || !Number.isInteger(row.vnum)) {
        return { status: 400, body: { error: 'each piece needs an integer item vnum' } };
      }
      if (!this.deps.items.has(row.vnum)) {
        return { status: 404, body: { error: `no item ${row.vnum} in the catalogue` } };
      }
      // The rare-drop rate. 100 and absence mean the same thing and are stored the same way; a
      // typed 0 is refused rather than stored, because a piece that can never appear is a lie the
      // editor would keep repeating.
      let percent: { percent?: number } = {};
      if (row.percent !== undefined && row.percent !== null && row.percent !== 100) {
        if (typeof row.percent !== 'number' || !Number.isInteger(row.percent) || row.percent < 1 || row.percent > 99) {
          return { status: 400, body: { error: 'percent must be a whole number from 1 to 99, or blank for always' } };
        }
        percent = { percent: row.percent };
      }
      if (row.slot === undefined || row.slot === null || row.slot === '') {
        loot.push({ vnum: row.vnum, ...percent });
        continue;
      }
      if (typeof row.slot !== 'string' || !(EQUIP_SLOTS as readonly string[]).includes(row.slot)) {
        return { status: 400, body: { error: `no such slot: ${String(row.slot)}` } };
      }
      loot.push({ vnum: row.vnum, slot: row.slot as EquipSlot, ...percent });
    }

    const applied = this.deps.live.authorMobLoot(vnum, loot);
    if (!applied) return { status: 404, body: { error: `no mob ${vnum} among the loaded templates` } };
    if (this.deps.mobOverridesFile) saveMobOverrides(this.deps.live.mobOverrides(), this.deps.mobOverridesFile);

    const standing = this.deps.live.liveCountOf(vnum);
    this.audit('mob.loot', { vnum, pieces: loot.length });
    return {
      status: 200,
      body: {
        ok: true,
        vnum,
        loot: applied.loot ?? [],
        /**
         * How many of this template are already standing in the world — every one of them unaffected.
         * Reported because "I authored it and nothing changed" is otherwise the first bug report.
         */
        spawned: standing,
      },
    };
  }

  /**
   * `GET /mobs/:vnum/template` — one template as it now stands, plus what is authored on it. **A9.**
   *
   * The editor's own read, and it is a separate route from the search for the reason the Items page
   * already learned: a list row carries what a list needs, and opening an editor on a summary means the
   * fields it does not show quietly become blank on the next save.
   */
  private mobTemplate(slug: string): AdminResponse {
    const vnum = Number(slug);
    if (!Number.isInteger(vnum)) return { status: 400, body: { error: `"${slug}" is not a mob vnum` } };
    const template = this.deps.live.mobTemplateOf(vnum);
    if (!template) return { status: 404, body: { error: `no mob ${vnum} among the loaded templates` } };
    return {
      status: 200,
      body: {
        mob: mobTemplateRow(template),
        authored: this.deps.live.mobOverrides().get(vnum) ?? null,
        // A9b. Whether there is a harvest under this creature decides two things the record cannot say for
        // itself: which fields may be edited, and whether the dangerous button says Restore or Delete.
        created: this.deps.live.authoredMobs().mobs.get(vnum) ?? null,
        /** How many are standing right now — every one of them unaffected by an edit. */
        spawned: this.deps.live.liveCountOf(vnum),
      },
    };
  }

  /**
   * `PATCH /mobs/:vnum/template` — **A9**, the field editor over the overlay A4c built.
   *
   * Owner's ask, 2026-08-06: *"we need to be able to edit existing mobs and create new mobs."* This is the
   * first half; creating is A9b, which needs an id space and a reset-table entry that does not exist yet.
   *
   * `authorItem`'s shape throughout: `null` clears a field back to the harvest, an unknown key is refused
   * **by name** rather than ignored, and the whole patch is validated before anything is written so an
   * edit either lands or does not.
   *
   * ## Two things the response says out loud
   *
   * `spawned` — how many of this vnum are walking around right now, every one of them unchanged. An edit
   * is per template, so *"I saved it and nothing happened"* is otherwise the first bug report, and Repop
   * on the Zones page is what turns *nothing happened* into *nothing has happened yet*.
   *
   * And the level, hit points and damage are what Phase 14b calibrated the fight against, so this route is
   * also the fastest way to make a zone unwinnable. The bounds here are wide on purpose — an operator is
   * allowed to build a level-60 kobold — but they are bounds: a level outside 1–{@link MAX_AUTHORED_LEVEL}
   * is a number the experience table has no row for, not a bold design choice.
   */
  private authorMob(slug: string, body: unknown): AdminResponse {
    const vnum = Number(slug);
    if (!Number.isInteger(vnum)) return { status: 400, body: { error: `"${slug}" is not a mob vnum` } };
    if (!this.deps.live.mobTemplateOf(vnum)) {
      return { status: 404, body: { error: `no mob ${vnum} among the loaded templates` } };
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'PATCH body must be a JSON object' } };
    }
    // **One Save for both kinds of mob, and the *server* decides which it is** — `authorItem`'s dispatch,
    // for the same reason. A created mob has no harvest to patch, so an edit to one is a re-draft of the
    // whole record: a different store, a different validator, and no *Restore harvested* because there is
    // nothing behind it. Deciding here rather than in the panel means the front end has one route to call
    // and cannot get the choice wrong; the vnum range is the discriminator, exactly as it is on disk.
    if (vnum >= AUTHORED_MOB_BASE) return this.reauthorMob(vnum, body as Record<string, unknown>);
    const patch = body as Record<string, unknown>;
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      return { status: 400, body: { error: 'nothing to change — send at least one field, or null to clear one' } };
    }
    for (const key of keys) {
      if (!MOB_PATCH_KEYS.has(key)) {
        return {
          status: 400,
          body: {
            error:
              `"${key}" is not authorable — one of: ${[...MOB_PATCH_KEYS].join(', ')}. ` +
              `Loot has its own route (PATCH /mobs/${vnum}/loot). Aggression and pursuit are rules rather ` +
              `than fields and half their clauses have nothing to evaluate until races and alignment exist.`,
          },
        };
      }
    }

    // Mutable local rather than `Partial<MobOverride>`, whose fields are readonly — `authorItem`'s shape.
    const next: {
      name?: string;
      room?: string;
      keywords?: readonly string[];
      level?: number;
      hp?: string;
      damage?: string;
      armourClass?: number;
      experience?: number;
      wimpyAt?: number;
      sprite?: string;
      spells?: readonly SpellId[];
      by?: string;
    } = {};
    const cleared: string[] = [];

    // Phase 20 slice 3: the field that turns a shaman's name into behaviour. Whole spell names or
    // ids, validated against the shared registry — the refusal lists what exists, because "no such
    // spell" with nothing after it is a guessing game.
    if (patch.spells !== undefined) {
      if (patch.spells === null) cleared.push('spells');
      else if (!Array.isArray(patch.spells)) {
        return { status: 400, body: { error: 'spells must be an array of spell ids, or null' } };
      } else {
        const spells: SpellId[] = [];
        for (const raw of patch.spells as unknown[]) {
          const id = typeof raw === 'string' ? (isSpellId(raw) ? raw : spellByName(raw)?.id) : undefined;
          if (!id) {
            return {
              status: 400,
              body: { error: `"${String(raw)}" is not a spell — one of: ${SPELL_IDS.join(', ')}` },
            };
          }
          if (!spells.includes(id)) spells.push(id);
        }
        if (spells.length === 0) return { status: 400, body: { error: 'spells must name at least one spell, or null' } };
        next.spells = spells.slice(0, 8);
      }
    }

    for (const [key, max] of [['name', MOB_NAME_MAX], ['room', MOB_ROOM_MAX], ['sprite', MOB_SPRITE_MAX]] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null || value === '') {
        cleared.push(key);
        continue;
      }
      if (typeof value !== 'string' || !value.trim()) {
        return { status: 400, body: { error: `${key} must be a non-empty string, or null to unauthor it` } };
      }
      if (value.length > max) return { status: 400, body: { error: `${key} must be at most ${max} characters` } };
      next[key] = value.trim();
    }

    if (patch.keywords !== undefined) {
      if (patch.keywords === null) cleared.push('keywords');
      else if (!Array.isArray(patch.keywords)) {
        return { status: 400, body: { error: 'keywords must be an array of words, or null' } };
      } else {
        const words = (patch.keywords as unknown[])
          .filter((w): w is string => typeof w === 'string')
          .map((w) => w.trim().toLowerCase())
          .filter((w) => w.length > 0);
        if (words.length === 0 || words.length !== patch.keywords.length) {
          return { status: 400, body: { error: 'keywords must be one or more non-empty words' } };
        }
        const long = words.find((w) => w.length > MOB_KEYWORD_MAX);
        if (long) return { status: 400, body: { error: `keyword "${long}" is over ${MOB_KEYWORD_MAX} characters` } };
        next.keywords = [...new Set(words)];
      }
    }

    for (const [key, min, max] of [
      ['level', 1, MAX_AUTHORED_LEVEL],
      ['armourClass', 0, MAX_AUTHORED_AC],
      ['experience', 0, MAX_AUTHORED_EXPERIENCE],
      ['wimpyAt', 0, MAX_AUTHORED_WIMPY],
    ] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null) {
        cleared.push(key);
        continue;
      }
      // **Refused rather than clamped**, the opposite of what the file loader does with the same number.
      // A form is a person still holding the keyboard, and telling them 200 is out of range is worth more
      // than quietly storing 60; a hand-edited file has nobody to tell, so salvaging is all that is left.
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        return { status: 400, body: { error: `${key} must be an integer from ${min} to ${max}, or null` } };
      }
      next[key] = value;
    }

    for (const key of ['hp', 'damage'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null || value === '') {
        cleared.push(key);
        continue;
      }
      // Validated by **parsing**, the loader's rule: `parseDice` is what the game will call on it, so
      // anything it refuses is a mob with no hit points or one that swings for `NaN`.
      if (typeof value !== 'string' || !parseDice(value.trim())) {
        return { status: 400, body: { error: `${key} must be dice the game can roll, like "12d8+40", or null` } };
      }
      next[key] = value.trim();
    }

    if (patch.by !== undefined) {
      if (patch.by === null) cleared.push('by');
      else if (typeof patch.by !== 'string') return { status: 400, body: { error: 'by must be a string or null' } };
      else next.by = patch.by.slice(0, 200);
    }

    const applied = this.deps.live.authorMob(vnum, next, cleared);
    if (!applied) return { status: 404, body: { error: `no mob ${vnum} among the loaded templates` } };
    if (this.deps.mobOverridesFile) saveMobOverrides(this.deps.live.mobOverrides(), this.deps.mobOverridesFile);

    this.audit('mob.author', { vnum, fields: keys, cleared });
    return {
      status: 200,
      body: {
        ok: true,
        mob: mobTemplateRow(applied),
        authored: this.deps.live.mobOverrides().get(vnum) ?? null,
        spawned: this.deps.live.liveCountOf(vnum),
      },
    };
  }

  /**
   * `POST /mobs/template` — **A9b**, a creature with no `.mob` record behind it.
   *
   * Owner's ask, 2026-08-06: *"we need to be able to edit existing mobs and create new mobs."* A9 was the
   * first half. This is A6b's shape for mobs: a whole record rather than a patch, a vnum from a reserved
   * base with a **stored** counter, and its own file with the opposite lifecycle rule — an emptied
   * override is deleted, while a created mob whose name is blanked is a bug rather than a request to
   * delete the creature.
   *
   * **The vnum is not the caller's to choose**, and the refusal says so. A form that could name its own
   * number could name one a future harvest claims, and a vnum is the join key between the template map,
   * every reset, every instance limit and every override — a collision there is two creatures silently
   * becoming one.
   */
  private createMob(body: unknown): AdminResponse {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'POST body must be a JSON object' } };
    }
    const draft = body as Record<string, unknown>;
    if (draft.vnum !== undefined) {
      return {
        status: 400,
        body: { error: 'vnum is allocated by the server — a mob may not choose its own join key' },
      };
    }
    const created = this.deps.live.authorNewMob(undefined, draft as MobDraft);
    if ('error' in created) return { status: 400, body: { error: created.error } };
    this.saveMade();

    this.audit('mob.create', { vnum: created.mob.vnum, name: stripColour(created.mob.name) });
    return { status: 201, body: { ok: true, vnum: created.mob.vnum, mob: mobTemplateRow(created.mob) } };
  }

  /**
   * The created-mob half of `PATCH /mobs/:vnum/template`. Reached only through {@link authorMob}'s dispatch.
   *
   * **An edit here is a re-draft of the whole record**, because there is no harvest underneath to patch —
   * so the fields the overlay path refuses (`aggressive`, `hunts`) are accepted, and *Restore harvested*
   * is not offered, since there is nothing behind it to restore to. The panel does not have to know which
   * kind of mob it is holding: the vnum range decides, here, exactly as it does for items.
   */
  private reauthorMob(vnum: number, patch: Record<string, unknown>): AdminResponse {
    const keys = Object.keys(patch);
    if (keys.length === 0) return { status: 400, body: { error: 'empty patch' } };
    // Laid over the record that exists, so a patch of one field is still a whole valid draft — the same
    // read-modify-validate an override does, with the record itself standing in for the harvest.
    const current = this.deps.live.authoredMobs().mobs.get(vnum);
    if (!current) return { status: 404, body: { error: `no mob ${vnum} was made here` } };
    const merged = { ...mobDraftOf(current.mob), ...patch };
    const edited = this.deps.live.authorNewMob(vnum, merged as MobDraft);
    if ('error' in edited) return { status: 400, body: { error: edited.error } };
    this.saveMade();

    this.audit('mob.reauthor', { vnum, fields: keys });
    return { status: 200, body: { ok: true, mob: mobTemplateRow(edited.mob), created: true } };
  }

  /**
   * `DELETE /mobs/:vnum/template` — unmakes a mob that was created here.
   *
   * **A harvested mob cannot be deleted, and the refusal says why**: the next `npm run worldgen` would put
   * it straight back, so a delete that appeared to work would be a lie with a restart's fuse on it.
   * Retiring a Duris creature is a zone edit, not a catalogue one.
   *
   * What is already standing keeps standing, and the response says how many — they are ordinary actors in
   * ordinary fights, and unmaking the idea of them mid-round would be a mob vanishing out of a swing.
   */
  private destroyMob(slug: string): AdminResponse {
    const vnum = Number(slug);
    if (!Number.isInteger(vnum)) return { status: 400, body: { error: `"${slug}" is not a mob vnum` } };
    if (vnum < AUTHORED_MOB_BASE) {
      return {
        status: 400,
        body: {
          error:
            `mob ${vnum} came from the harvest and cannot be deleted — the next worldgen would restore ` +
            `it. Only mobs created here can be removed.`,
        },
      };
    }
    const gone = this.deps.live.unmakeMob(vnum);
    if (!gone) return { status: 404, body: { error: `no mob created here with vnum ${vnum}` } };
    this.saveMade();

    this.audit('mob.delete', { vnum, name: stripColour(gone.name), standing: gone.standing });
    return { status: 200, body: { ok: true, standing: gone.standing } };
  }

  /** `GET /mobs/:vnum/placements` — the rooms a creature is authored to appear in. **A9c.** */
  private mobPlacements(slug: string): AdminResponse {
    const vnum = Number(slug);
    if (!Number.isInteger(vnum)) return { status: 400, body: { error: `"${slug}" is not a mob vnum` } };
    if (!this.deps.live.mobTemplateOf(vnum)) {
      return { status: 404, body: { error: `no mob ${vnum} among the loaded templates` } };
    }
    return { status: 200, body: { vnum, placements: this.placementRows(vnum), standing: this.deps.live.liveCountOf(vnum) } };
  }

  /**
   * `PUT /mobs/:vnum/placements` — **A9c**, where a creature lives.
   *
   * Owner's ask, 2026-08-06: *"the mob needs to be assigned a room in a zone and not just dropped by
   * hand."* A9b made a creature that could be spawned; this is what makes it *population* — it appears
   * on every repop, in the rooms it was given, and survives a restart.
   *
   * **PUT rather than PATCH, and the whole list rather than one row.** A placement has no identity of its
   * own to address — it is a room and a number — so *the set of rooms this thing lives in* is the smallest
   * thing that can be stated without inventing row ids. An empty list unplaces it, which is the same
   * shape the loot route already uses for the same reason.
   *
   * ## The zone is derived, never asked for
   *
   * A room already knows which zone it is in; asking the caller to repeat it is a second thing they can
   * get wrong, and a disagreement between the two would be a reset filed in a table that never runs. So a
   * room is refused when the world does not have it, and refused **by name** when its zone has no
   * population file — that zone has no reset table for the command to live in, and a placement that
   * quietly never fires is indistinguishable from the feature not working.
   *
   * ## What it does not do
   *
   * It does not spawn anything by itself, and the response says so with `standing`. Placement is what the
   * *next repop* does, exactly as authored loot is — and Repop on the Zones page is the button that turns
   * *nothing happened* into *there it is*. Unplacing likewise leaves what is standing standing: those are
   * ordinary creatures in ordinary fights, and vanishing one mid-round is not a path the game has.
   */
  private placeMob(slug: string, body: unknown): AdminResponse {
    const vnum = Number(slug);
    if (!Number.isInteger(vnum)) return { status: 400, body: { error: `"${slug}" is not a mob vnum` } };
    if (!this.deps.live.mobTemplateOf(vnum)) {
      return { status: 404, body: { error: `no mob ${vnum} among the loaded templates` } };
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'PUT body must be a JSON object' } };
    }
    const raw = (body as { placements?: unknown }).placements;
    if (!Array.isArray(raw)) return { status: 400, body: { error: 'body must be {"placements": [...]}' } };
    if (raw.length > MAX_PLACEMENTS_PER_MOB) {
      return { status: 400, body: { error: `at most ${MAX_PLACEMENTS_PER_MOB} rooms` } };
    }

    // Validated whole before anything is written, so an edit either lands or does not.
    const rows: Placement[] = [];
    for (const entry of raw as unknown[]) {
      if (typeof entry !== 'object' || entry === null) {
        return { status: 400, body: { error: 'each placement must be {"room": <id>, "limit": <count>}' } };
      }
      const row = entry as { room?: unknown; limit?: unknown };
      if (typeof row.room !== 'number' || !Number.isInteger(row.room)) {
        return { status: 400, body: { error: 'each placement needs an integer room id' } };
      }
      const located = this.deps.world.locate(row.room as RoomId);
      if (!located) return { status: 404, body: { error: `no room ${row.room} in the loaded world` } };
      // Named rather than merely refused: a zone with no population file has no reset table, so the
      // command would have nowhere to live and would never fire. That is worth saying out loud.
      // `repopIn` answers exactly the question that matters: a zone has a clock if and only if it has a
      // reset table, so an undefined answer is a zone whose commands nothing would ever run.
      const zone = this.deps.world.zoneOf(row.room as RoomId);
      if (zone === undefined || this.deps.live.repopIn(zone as ZoneId) === undefined) {
        return {
          status: 400,
          body: {
            error:
              `room ${row.room} is in a zone this server does not populate, so a placement there would ` +
              `never fire. Add the zone to world.config.json first.`,
          },
        };
      }
      const limit = row.limit === undefined || row.limit === null ? 1 : row.limit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_PLACEMENT_LIMIT) {
        return { status: 400, body: { error: `limit must be a whole number from 1 to ${MAX_PLACEMENT_LIMIT}` } };
      }
      if (rows.some((already) => already.room === row.room)) {
        // Two rows for one room would be two `M` commands sharing a global cap — the second could only
        // ever be the one that finds the limit met. Refused rather than deduplicated, so nobody believes
        // they placed two.
        return { status: 400, body: { error: `room ${row.room} is listed twice — raise its limit instead` } };
      }
      rows.push({ room: row.room as RoomId, limit });
    }

    const applied = this.deps.live.placeMob(vnum, rows);
    if (!applied) return { status: 404, body: { error: `no mob ${vnum} among the loaded templates` } };
    if (this.deps.placementsFile) savePlacements(this.deps.live.placements(), this.deps.placementsFile);

    this.audit('mob.place', { vnum, rooms: rows.map((row) => row.room) });
    return {
      status: 200,
      body: {
        ok: true,
        vnum,
        placements: this.placementRows(vnum),
        /** How many are standing right now. A placement lands on the **next repop**, not on this second. */
        standing: this.deps.live.liveCountOf(vnum),
      },
    };
  }

  /** A vnum's placements, each with the room's own name — an id alone is not something to check work in. */
  private placementRows(vnum: number): { room: number; limit: number; name: string; zone: number | undefined }[] {
    return [...(this.deps.live.placements().get(vnum) ?? [])].map((row) => ({
      room: row.room,
      limit: row.limit,
      // Named here because only this side has the world. The overlay stores the id — that is the join key
      // and the only thing that should be persisted — but a list of bare numbers is one nobody can read.
      name: this.deps.world.locate(row.room)?.room.name ?? `room ${row.room}`,
      zone: this.deps.world.zoneOf(row.room),
    }));
  }

  /** Persists the created-mob overlay, if this server was given somewhere to put it. */
  private saveMade(): void {
    if (this.deps.authoredMobsFile) saveAuthoredMobs(this.deps.live.authoredMobs(), this.deps.authoredMobsFile);
  }

  /* ------------------------------------------------------------------------ */
  /* A7q — quests                                                              */
  /* ------------------------------------------------------------------------ */

  /**
   * `GET /quests` — every authored quest, with the **names** behind its three vnums.
   *
   * The names are resolved here rather than fetched per row by the panel, for the reason the mob search
   * folds its overrides in: the server already has the maps, and a request per row would be four
   * requests to answer a question one map lookup answers. And it is the whole difference between a list
   * an operator can check their work against and a list of numbers — *"Gwark"* against *"1401"*.
   *
   * `null` where a vnum names nothing this server loaded, which is a real state rather than an error:
   * a checkout with no Duris source has an empty item catalogue by design, and a quest is content that
   * outlives the run it was written on.
   */
  private quests(): AdminResponse {
    const quests = [...this.deps.live.quests().values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { status: 200, body: { total: quests.length, quests: quests.map((quest) => this.questRow(quest)) } };
  }

  /**
   * One quest as the panel reads it: the record, plus the names its numbers stand for.
   *
   * The names ride *beside* the definition rather than inside it — `giver` stays the number, because the
   * number is the join key and a form that posted a name back would be posting something the file cannot
   * hold. A hint, in other words, and never a field.
   */
  private questRow(quest: QuestDef): Record<string, unknown> {
    const giver = this.deps.live.mobTemplateOf(quest.giver);
    const target =
      quest.objective.kind === 'kill'
        ? this.deps.live.mobTemplateOf(quest.objective.vnum)?.name
        : this.deps.items.get(quest.objective.vnum)?.name;
    const rewardItem = quest.reward.item === undefined ? undefined : this.deps.items.get(quest.reward.item)?.name;
    return {
      ...quest,
      giverName: giver ? stripColour(giver.name) : null,
      /** How many of the giver are standing right now — a quest whose patron never spawns is unfindable. */
      giverStanding: giver ? this.deps.live.liveCountOf(quest.giver) : 0,
      targetName: target ? stripColour(target) : null,
      // The same hint for the third reward pool. Null both when nothing is paid and when the vnum
      // names nothing loaded; the form seeds its lookup from it and re-resolves either way.
      rewardItemName: rewardItem ? stripColour(rewardItem) : null,
    };
  }

  /**
   * `POST /quests` — A7q's create.
   *
   * **The id comes from the caller**, and this is the one authoring route where that is right rather
   * than a mistake. Items and mobs allocate their vnums server-side because a caller who could choose
   * one could choose one a future harvest claims — but a quest id is a slug in a hand-authored file
   * that nothing harvests, and it is what a *person* has to recognise in an audit line and in a save
   * file. So it is theirs to choose, and the only rule is that it may not already be taken.
   */
  private createQuest(body: unknown): AdminResponse {
    const draft = asRecord(body);
    if (!draft) return { status: 400, body: { error: 'POST body must be a JSON object' } };

    const drafted = draftQuest(draft as QuestDraft);
    if ('error' in drafted) return { status: 400, body: { error: drafted.error } };
    const refused = this.questWorldCheck(drafted.quest);
    if (refused) return refused;

    // 409 rather than 400: the draft is well-formed, and what is wrong is the world it is landing in.
    // Silently replacing the quest that already holds this id would rewrite work in progress for every
    // character carrying it, which is the shape of edit an admin tool exists to not make by accident.
    if (this.deps.live.quests().has(drafted.quest.id)) {
      return { status: 409, body: { error: `a quest with id "${drafted.quest.id}" already exists — pick another id, or edit that one` } };
    }

    const applied = this.applyQuests([...this.deps.live.quests().values(), drafted.quest]);
    this.audit('quest.create', { id: drafted.quest.id, giver: drafted.quest.giver, givers: applied.givers.length });
    return { status: 201, body: { ok: true, quest: this.questRow(drafted.quest), ...applied } };
  }

  /**
   * `PATCH /quests/:id` — an edit, laid over the record that exists and re-validated whole.
   *
   * The `reauthorMob` shape rather than a field-by-field patch: a quest is a small whole record with no
   * harvest under it, so a patch of one field is still a complete draft and there is only ever one
   * validator to keep honest.
   *
   * **The id may not change, and that refusal is the design.** `PlayerRecord.quests` is keyed by quest
   * id, so a rename does not move anybody's progress — it strands it, and every character mid-quest
   * silently starts again from nothing. `decodeQuests` drops ids the definitions no longer carry, so
   * nothing *breaks*; it is simply lost. A rename is therefore a delete and a create: two acts, both
   * audited, both the operator's own.
   */
  private authorQuest(slug: string, body: unknown): AdminResponse {
    const current = this.deps.live.quests().get(slug);
    if (!current) return { status: 404, body: { error: `no quest with id "${slug}"` } };
    const patch = asRecord(body);
    if (!patch) return { status: 400, body: { error: 'PATCH body must be a JSON object' } };
    const keys = Object.keys(patch);
    if (keys.length === 0) return { status: 400, body: { error: 'empty patch' } };
    if (patch.id !== undefined && patch.id !== slug) {
      return {
        status: 409,
        body: {
          error:
            `a quest's id is the key every character's progress is filed under, so it cannot be ` +
            `changed here — every character mid-quest would lose theirs. Delete "${slug}" and create ` +
            `the new one, which is the same thing said out loud.`,
        },
      };
    }

    const drafted = draftQuest({ ...current, ...patch, id: slug } as QuestDraft);
    if ('error' in drafted) return { status: 400, body: { error: drafted.error } };
    const refused = this.questWorldCheck(drafted.quest);
    if (refused) return refused;

    const applied = this.applyQuests(
      [...this.deps.live.quests().values()].map((quest) => (quest.id === slug ? drafted.quest : quest)),
    );
    this.audit('quest.author', { id: slug, fields: keys.filter((key) => key !== 'id'), givers: applied.givers.length });
    return { status: 200, body: { ok: true, quest: this.questRow(drafted.quest), ...applied } };
  }

  /**
   * `DELETE /quests/:id` — the quest stops existing, and its giver stops being one.
   *
   * **Two consequences worth stating rather than discovering**, and both are reported in the response.
   * The giver loses its `?` and its immunity the instant this returns, because the registries are
   * re-seeded from what is left — that is `resynced` (how many standing bodies were re-sent to the
   * people watching them). And every character who was carrying this quest keeps a row in their save
   * file that now names nothing: `decodeQuests` drops an unknown id on the next load, so the row is
   * inert rather than dangerous, but *"a quest deleted is progress lost"* is the honest sentence and
   * `stranded` is how many characters online right now it applies to.
   */
  private destroyQuest(slug: string): AdminResponse {
    const quest = this.deps.live.quests().get(slug);
    if (!quest) return { status: 404, body: { error: `no quest with id "${slug}"` } };

    const stranded = this.deps.live.online().filter((player) => player.quests.has(slug)).length;
    const applied = this.applyQuests([...this.deps.live.quests().values()].filter((row) => row.id !== slug));
    this.audit('quest.delete', { id: slug, giver: quest.giver, stranded, ...applied });
    return { status: 200, body: { ok: true, id: slug, stranded, ...applied } };
  }

  /**
   * The vnums a quest names, against the world this server actually loaded.
   *
   * Split from `draftQuest` on purpose: that validator answers a **form and a hand-edited file**, and
   * the file is read at boot before anything is loaded. So shape lives there and existence lives here,
   * where there is a world to ask and a person to tell.
   *
   * **The giver is checked outright**, because it is the one vnum with live consequences — it seeds the
   * `?` badge and the untouchable registry, and a giver that names nothing is a quest nobody can ever
   * be offered. The **objective's target is checked only when there is a catalogue to check against**:
   * `deps.items` is legitimately empty on a checkout with no Duris source (see its own note), and a
   * rule that refused every `bring` quest on such a checkout would be enforcing the absence of a
   * git-ignored directory.
   */
  private questWorldCheck(quest: QuestDef): AdminResponse | undefined {
    if (!this.deps.live.mobTemplateOf(quest.giver)) {
      return { status: 400, body: { error: `no mob ${quest.giver} among the loaded templates — a quest needs a giver who exists` } };
    }
    if (quest.objective.kind === 'kill' && !this.deps.live.mobTemplateOf(quest.objective.vnum)) {
      return {
        status: 400,
        body: { error: `no mob ${quest.objective.vnum} among the loaded templates — nothing to kill, so the quest could never complete` },
      };
    }
    if (quest.objective.kind === 'bring' && this.deps.items.size > 0 && !this.deps.items.get(quest.objective.vnum)) {
      return {
        status: 400,
        body: { error: `no item ${quest.objective.vnum} in the catalogue — nothing to bring, so the quest could never complete` },
      };
    }
    // The reward item takes the `bring` target's rule exactly, and for both of its halves: it is a
    // catalogue vnum, and the catalogue is legitimately empty on a checkout with no Duris source.
    if (quest.reward.item !== undefined && this.deps.items.size > 0 && !this.deps.items.get(quest.reward.item)) {
      return {
        status: 400,
        body: { error: `no item ${quest.reward.item} in the catalogue — the quest would owe a reward that cannot be made` },
      };
    }
    return undefined;
  }

  /**
   * Applies a new set of quests to the running world and writes the file, in that order.
   *
   * **Live first, disk second**, the order every overlay in this file keeps: the live map is the truth
   * and the file is its shadow, so a write that fails leaves a world that is right and a file that is
   * behind, rather than the reverse.
   */
  private applyQuests(next: readonly QuestDef[]): { givers: readonly number[]; resynced: number } {
    const applied = this.deps.live.setQuests(next);
    if (this.deps.questsFile) saveQuests(next, this.deps.questsFile);
    return { givers: applied.givers, resynced: applied.resynced };
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

  /**
   * `POST /players/:slug/give` — puts one instance of a catalogue item into a character's hands.
   *
   * **A6b's completion test, and A4's first tool.** An item that can be authored and never held is not
   * created in any sense a person can check: the whole point of the create form is that the thing shows
   * up in a bag, on a paper doll, in a fight. This is the shortest honest path from the catalogue to a
   * pair of hands, and it is deliberately about *any* item rather than only created ones — the mob and
   * spawn tooling A4 brings wants the same call.
   *
   * Online only, because an instance goes into a live inventory. Giving to a stored character would
   * mean editing a save file's bag, which is a different and much less safe operation.
   */
  private give(slug: string, body: unknown): AdminResponse {
    const player = this.findOnline(slug);
    if (!player) return { status: 409, body: { error: `"${slug}" is not online — an item needs a pair of hands` } };
    const vnum = (body as { vnum?: unknown } | null)?.vnum;
    if (typeof vnum !== 'number' || !Number.isInteger(vnum)) {
      return { status: 400, body: { error: 'body must be {"vnum": <integer>}' } };
    }
    if (!this.deps.items.has(vnum)) return { status: 404, body: { error: `no item ${vnum} in the catalogue` } };

    const given = this.deps.live.giveItem(player, vnum);
    // A full bag is the operator's problem to solve, not ours to solve by dropping it on the floor —
    // the same refusal `remove` makes, and for the same reason.
    if ('error' in given) return { status: 409, body: { error: given.error } };
    this.audit('give', { slug, vnum, name: given.name });
    return { status: 200, body: { ok: true, name: given.name } };
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

  /**
   * Throws an operator switch — PvP, and since the owner's event ask (2026-08-07), movement costs.
   *
   * **The change is announced to the world**, and that is a rule rather than a courtesy: one switch
   * decides whether the person next to you can kill you, the other whether the ocean can drown you,
   * and finding out by dying is not acceptable either way. The announcement goes out only when a
   * value actually *changes*, so re-saving the panel does not spam a world that is already correct.
   */
  private patchSettings(body: unknown): AdminResponse {
    const raw = (body ?? {}) as { pvp?: unknown; movementCosts?: unknown };
    if (raw.pvp === undefined && raw.movementCosts === undefined) {
      return { status: 400, body: { error: 'body must set "pvp" and/or "movementCosts", each true or false' } };
    }
    for (const key of ['pvp', 'movementCosts'] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
        return { status: 400, body: { error: `${key} must be true or false` } };
      }
    }
    const before = this.deps.live.settings();
    const next: WorldSettings = {
      pvp: typeof raw.pvp === 'boolean' ? raw.pvp : before.pvp,
      movementCosts: typeof raw.movementCosts === 'boolean' ? raw.movementCosts : before.movementCosts,
    };
    if (next.pvp === before.pvp && next.movementCosts === before.movementCosts) {
      return { status: 200, body: { ok: true, settings: before, changed: false } };
    }

    this.deps.live.setSettings(next);
    let heard = 0;
    if (next.pvp !== before.pvp) {
      heard = this.deps.announce(
        next.pvp
          ? 'Player killing is now ON. Other players can attack you and loot your corpse.'
          : 'Player killing is now OFF. Players can no longer attack each other.',
        { kind: 'world' },
      );
    }
    if (next.movementCosts !== before.movementCosts) {
      heard = this.deps.announce(
        next.movementCosts
          ? 'Movement costs are back ON. Terrain tires you again, and deep water can drown you.'
          : 'Movement is FREE for now — no terrain costs, no exhaustion, no drowning. Enjoy it while it lasts.',
        { kind: 'world' },
      );
    }
    this.audit('settings', { pvp: next.pvp, movementCosts: next.movementCosts, heard });
    return { status: 200, body: { ok: true, settings: next, changed: true, heard } };
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
 * Whether a catalogue entry answers to a search term.
 *
 * Three surfaces, and each is there for a different kind of operator. **Keywords** are what a player
 * would type, so searching the way the game resolves names finds what a bug report is about.
 * **The display name** is what the operator is reading on screen — with colour codes stripped, or
 * `silver` would miss `&+Ca silver dagger&N` and look like the item is not in the world. **The vnum**
 * is exact, because a reset table names items by number and nothing else.
 */
function itemMatches(template: ItemTemplate, term: string): boolean {
  if (String(template.vnum) === term) return true;
  if (template.keywords.some((word) => word.toLowerCase().includes(term))) return true;
  return stripColour(template.name).toLowerCase().includes(term);
}

/** One row of the search result: enough to scan, not the whole record. */
function itemRow(template: ItemTemplate): Record<string, unknown> {
  return {
    vnum: template.vnum,
    name: template.name,
    keywords: template.keywords,
    type: template.type,
    slot: template.slot ?? null,
    ac: template.ac,
    size: template.size,
    cost: template.cost,
    // Only when they mean something, so a row of nulls does not imply a sword has a capacity of zero.
    ...(template.damage ? { damage: `${template.damage.count}d${template.damage.sides}` } : {}),
    // Windsong's field: which ladder rung it swings as, so the editor can show it and a save's
    // response can prove it took.
    ...(template.weaponClass === undefined ? {} : { weaponClass: template.weaponClass }),
    ...(template.twoHanded ? { twoHanded: true } : {}),
    ...(template.stackLimit > 1 ? { stackLimit: template.stackLimit } : {}),
    ...(template.uses === undefined ? {} : { uses: template.uses }),
    ...(template.container ? { container: template.container } : {}),
    ...(template.coins ? { coins: template.coins } : {}),
    // A7c. Absent for the great majority — 319 sheets against 16,421 items — which is exactly why it
    // belongs on the row: what the search shows is *which* of these have been given a picture, and a
    // row that could not say so made the picker's own work invisible the moment it was saved.
    ...(template.art ? { art: template.art } : {}),
    // A6c. 64 of 16,421 entries emit light, so a row that carries one is saying something — and the
    // editor needs it to show what is already there rather than making an author retype it.
    ...(template.light ? { light: template.light } : {}),
    // Phase 16. Absent at average, which is two thirds of the catalogue — so a row that carries one
    // is saying something. **This is the reader that earns the field its place on the template**: the
    // bonus is already folded into `ac`, and without this nothing could answer "why is this steel
    // helm better than that one".
    ...(template.craftsmanship === undefined ? {} : { craftsmanship: template.craftsmanship }),
  };
}

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
        // Parsed against a throwaway base because `req.url` is a path, not an absolute URL, and
        // `URLSearchParams` is what decodes `%20` and `+` correctly — an item search is free text and
        // hand-rolling that is how a query for "elven long sword" arrives as one word.
        query: Object.fromEntries(new URL(req.url ?? '/', 'http://admin.invalid').searchParams),
      })
      .then(respond)
      .catch((err: unknown) => {
        console.error('[admin] route threw:', err);
        respond({ status: 500, body: { error: (err as Error).message ?? 'admin route failed' } });
      });
  });
}

/** The body as a plain record, or undefined for anything that is not one. */
function asRecord(body: unknown): Record<string, unknown> | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

export type { StoredSummary };
