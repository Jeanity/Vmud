/**
 * Character persistence.
 *
 * One JSON file per character under `data/players/`. A real database is overkill for what is
 * currently a handful of integers and a bitset per name, and files are trivially inspectable while
 * debugging.
 *
 * ## What is stored
 *
 * The `seen` set: every tile of every {@link Place} this character has ever had light fall on. It is
 * held as one bitset per Place — 3.3 KB of bits for a fully-explored 168x156 grid, against ~150 KB
 * for the same thing as a JSON array of indices — and written as base64.
 *
 * `seen` is emphatically *not* `visible`. Visibility is recomputed from the character's position and
 * is never stored; `seen` is the union of every visible set so far and never shrinks. Nothing in this
 * file knows how visibility is computed, and it must stay that way: this is a record of where a
 * character has been, not a cache of what they can see.
 *
 * The `taken` set: which ground pickups this character has collected. Same shape of fact as `seen` —
 * a monotonically growing record of what this character has done to the world — and stored for the
 * same reason, since ground pickups are otherwise recomputed from the room id on demand and would
 * respawn on every restart. Nothing here knows what a pickup *is*; see `pickups.ts`.
 */

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AffectFlag,
  APPLY_LOCATIONS,
  STARTING_CAPACITY,
  emptyInventory,
  readEquipped,
  readInventory,
  readItem,
  UNLIMITED_DURATION,
  affectKind,
  hasFlag,
  newAffect,
  placeKey,
  type Affect,
  type AffectType,
  type Equipped,
  type Inventory,
  type ApplyLocation,
  type Place,
  type RoomId,
} from '@mygame/shared';
// A subpath import: `vision` is not re-exported from the package barrel.
import {
  bitsFromBase64,
  bitsToBase64,
  bitsetAddAll,
  bitsetBytes,
  createBitset,
} from '@mygame/shared/vision.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_PLAYER_DIR = join(REPO_ROOT, 'data', 'players');

/** Milliseconds of quiet before a dirty record is flushed to disk. */
const SAVE_DEBOUNCE_MS = 2000;

export interface PlayerRecord {
  name: string;
  /**
   * Seen tiles per Place, keyed by {@link placeKey}. One bitset over the tile indices of that
   * Place's grid.
   *
   * Per Place rather than one global set because tile indices only mean anything against the grid
   * they were computed on: index 400 is a different spot on every level of every zone.
   */
  readonly seen: Map<string, Uint8Array>;
  /**
   * Ground pickups this character has collected, by `pickupKey`.
   *
   * Not per Place: a pickup key is built from the room id, which is globally unique, so one flat set
   * spans the whole world. That is the opposite of `seen` above and for the opposite reason — tile
   * indices only mean anything against a grid, room ids mean the same thing everywhere.
   *
   * **Per character, deliberately.** A pickup is not a world object that one player can take from
   * another; every character finds their own copy and this records which of them *this* character
   * has found. See the header of `pickups.ts` for why that simplification is the right one until
   * there is a real item system.
   */
  readonly taken: Set<string>;
  /**
   * Every timed effect worth keeping — **the one persistence path**.
   *
   * This replaced a pair of bespoke fields (`light`, `lightRemainingMs`) in Phase 5b, and the reason
   * they were there is the reason this is: a character who found a lantern and then dropped their
   * connection came back at the bare radius **and** found every room they had emptied still empty, so
   * every disconnect permanently reduced the light obtainable in the world for them. `node --watch`
   * restarts the dev server on every code change, which made that the normal case rather than an edge
   * one. The carried light is now one row in here.
   *
   * Affects flagged `NoSave` never reach this list — see {@link PlayerStore.setAffects}. An empty list
   * is a character nothing is affecting, which is what a new one is. Nothing in this file knows what
   * any particular affect *means*; a type or a location the catalogue no longer recognises is dropped
   * on load rather than resolved to an error.
   */
  affects: Affect[];
  lastRoom: RoomId | undefined;
  /**
   * How far below full this character's pools were, **not** what they were.
   *
   * The MUD's rule, and the reasoning is worth keeping: `max_hit` is derived from level, constitution,
   * class, worn gear and more, so it is not the same number from one login to the next. Persist the
   * *value* and a character who took off a ring of health between sessions comes back at more than
   * their new maximum, or — the other way round — putting one on silently heals them. Persist the
   * *wound* and the arithmetic works whichever way the maximum moved.
   *
   * Duris does exactly this and calls it `missing_hps`, saving it before every stat recompute and
   * restoring it after. Ours is the same idea at a coarser grain: once per save.
   *
   * `undefined` means unhurt, which is what a new character is.
   */
  missing: { hp: number; mana: number; move: number } | undefined;
  /**
   * The level this character has reached and the experience they hold, or undefined for one
   * neither has ever moved for.
   *
   * **Persisted by the owner's decision (2026-08-02), ahead of Phase 14b — the storage half only.**
   * **`maxHp` is stored rather than derived** (Phase 14b). Hit points are rolled once per level —
   * Duris' `number(0,3) + 1` — so no formula can reproduce them, and a character's maximum must not
   * change because a function did. It is absent on every record written before that phase, which is
   * why the restore falls back to the level's expected average instead of to nothing.
   *
   * `{level: 1, experience: 0}` with no hit points is stored as undefined: that is what a brand-new
   * character is, and recording it would have every file assert a fact nothing established.
   */
  progress: { level: number; experience: number; maxHp?: number } | undefined;
  /**
   * What this character is wearing. Phase 14b's starting kit, and later whatever they have found.
   *
   * Stored for the same reason `maxHp` is: it is **rolled**, at creation, and a character who
   * reconnected into a freshly-rolled kit could reroll until they liked it. Absent on a record from
   * before the phase, which restores as "keep whatever the fresh spawn rolled" — the only honest
   * answer, since there is nothing to put back.
   */
  equipped: Equipped | undefined;
  /**
   * What this character is carrying. Phase 15b.
   *
   * Persisted for a blunter reason than the kit's: **a bag that empties on logout is worse than no
   * bag**, because a player would learn not to carry anything. Absent on a record from before the
   * phase, which restores as an empty bag — the only honest answer, since nothing was carried.
   */
  inventory: Inventory | undefined;
}

/**
 * What a pre-v4 save's room id maps onto: the tiles that room used to uncover, and the Place whose
 * grid those indices belong to.
 *
 * A function rather than a `GameWorld` handle so persistence keeps no opinion about how the world is
 * loaded, and so the migration can be tested without one.
 */
export type LegacyRoomResolver = (room: RoomId) => LegacyRoomTiles | undefined;

export interface LegacyRoomTiles {
  readonly place: Place;
  /** Tiles on that Place's grid, so a bitset can be sized to it. */
  readonly tileCount: number;
  readonly tiles: Iterable<number>;
}

export interface PlayerStoreOptions {
  /** Where character files live. Defaults to `data/players` at the repo root. */
  readonly dir?: string;
  /**
   * How to migrate a pre-v4 save. Without one, an old `explored` list is discarded with a warning
   * rather than being allowed to stop a character logging in.
   */
  readonly resolveLegacyRoom?: LegacyRoomResolver;
}

interface StoredRecord {
  name: string;
  /** Rolled hit-point maximum. Absent before Phase 14b, when it was derived from the level instead. */
  maxHp?: number;
  /** Worn kit. Absent before Phase 14b. */
  equipped?: unknown;
  /** Carried items and bag capacity. Absent before Phase 15b. */
  inventory?: unknown;
  /** Base64 bitset per {@link placeKey}. */
  seen?: Record<string, string>;
  /** Ground pickup keys this character has collected. Absent in any save written before v5. */
  taken?: string[];
  /** Savable affects. Absent before v9. */
  affects?: StoredAffect[];
  /**
   * Pre-v9 only: the carried light, when it was a field of its own rather than an affect.
   *
   * Read on load, converted into a `light` affect, and never written again — exactly the treatment
   * `explored` got when fog went tile-granular. The two fields are one fact, so they migrate together
   * or not at all.
   */
  light?: string;
  lightRemainingMs?: number;
  /**
   * How far below full each pool was. Absent before v8, and absent for an unhurt character.
   *
   * The wound, never the value — see {@link PlayerRecord.missing}.
   */
  missing?: { hp?: number; mana?: number; move?: number };
  /**
   * The level reached and the experience held. Absent for a character neither has moved for — see
   * {@link PlayerRecord.progress}. Flat rather than nested because this file is hand-editable and
   * `"level": 35` is the edit somebody will actually make.
   */
  level?: number;
  experience?: number;
  /**
   * Pre-v4 only: the rooms this character had entered, when fog was room-granular.
   *
   * Read on load, converted to tiles, and never written again — the next save of a migrated
   * character carries `seen` alone.
   */
  explored?: number[];
  lastRoom?: number;
  savedAt: string;
}

/**
 * One affect on disk. The record's own fields, minus the ones that are not facts about the character.
 *
 * `warned` is not written: whether you have already been told your torch is low is a property of the
 * session, and being warned twice across a reconnect is better than being warned never. The type and
 * the location are both validated against their catalogues on the way back in, because this file is
 * hand-editable and an unknown `apply` would otherwise install an affect that feeds a stat nothing
 * derives — invisible, permanent, and impossible to explain.
 */
interface StoredAffect {
  type: string;
  durationMs: number;
  apply: string;
  modifier: number;
  flags: number;
  context?: string;
}

/**
 * One character file as the roster sees it — identity plus counts, never the contents.
 *
 * What the admin panel's player list is built from. Counts rather than the data itself because the
 * roster is a table, not an editor: shipping every bitset to draw "12,408 tiles seen" would be most
 * of the file for none of the use.
 */
export interface StoredSummary {
  /** The filename's identity — what every store operation keys on. */
  readonly slug: string;
  readonly name: string;
  /** When the file was last written, or undefined for a record not yet flushed. */
  readonly savedAt: string | undefined;
  readonly lastRoom: RoomId | undefined;
  readonly seenTiles: number;
  readonly takenCount: number;
  readonly affectCount: number;
  /** The stored deficit, when one is recorded. See {@link PlayerRecord.missing}. */
  readonly wound: { hp: number; mana: number; move: number } | undefined;
  /** The stored level, when one is recorded. See {@link PlayerRecord.progress}. */
  readonly level: number | undefined;
}

/**
 * Maps a character name to a safe filename.
 *
 * Names arrive from the network, so this must never produce a path that escapes the directory:
 * everything outside the allowed set is dropped rather than escaped, and an empty result is
 * rejected by the caller.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Total tiles this character has ever seen, across every Place. For logging. */
export function seenTileCount(record: PlayerRecord): number {
  let total = 0;
  for (const bits of record.seen.values()) {
    for (let i = 0; i < bits.length; i++) total += POPCOUNT[bits[i] ?? 0] ?? 0;
  }
  return total;
}

const POPCOUNT = /* @__PURE__ */ (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = (i & 1) + (table[i >> 1] ?? 0);
  return table;
})();

export class PlayerStore {
  private readonly records = new Map<string, PlayerRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly dir: string;
  private readonly resolveLegacyRoom: LegacyRoomResolver | undefined;

  constructor(options: PlayerStoreOptions = {}) {
    this.dir = options.dir ?? DEFAULT_PLAYER_DIR;
    this.resolveLegacyRoom = options.resolveLegacyRoom;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Loads a character from disk, or creates a blank one. */
  load(name: string): PlayerRecord {
    const slug = slugify(name);
    const cached = this.records.get(slug);
    if (cached) return cached;

    let record: PlayerRecord = {
      name,
      seen: new Map(),
      taken: new Set(),
      affects: [],
      lastRoom: undefined,
      missing: undefined,
      progress: undefined,
      equipped: undefined,
      inventory: undefined,
    };
    if (slug) {
      try {
        const stored = JSON.parse(readFileSync(join(this.dir, `${slug}.json`), 'utf8')) as StoredRecord;
        record = {
          name: stored.name ?? name,
          seen: decodeSeen(stored.seen),
          taken: decodeTaken(stored.taken),
          affects: decodeAffects(stored, elapsedSince(stored.savedAt)),
          lastRoom: stored.lastRoom,
          missing: decodeMissing(stored.missing),
          progress: decodeProgress(stored.level, stored.experience, stored.maxHp),
        equipped: readEquipped(stored.equipped),
        inventory: stored.inventory === undefined ? undefined : readInventory(stored.inventory, readItem),
        };
        // A save written by the previous version has room ids and no bitsets. Refusing to load it
        // would lock a character out of their own account over a data format; this converts what it
        // can and shrugs at the rest.
        if (Array.isArray(stored.explored) && stored.explored.length > 0) {
          this.migrateExplored(record, stored.explored, slug);
        }
      } catch {
        // No file yet, or it is unreadable. A fresh character is the right fallback either way —
        // losing a seen map is annoying, refusing to let someone play is worse.
      }
    }
    this.records.set(slug, record);
    return record;
  }

  /**
   * This character's seen bitset for a Place, sized to that Place's grid and created on first use.
   *
   * The result aliases the record, so callers may read it (to ship as base64, or to gate a path) but
   * must go through {@link markSeen} to add to it — otherwise the record is never marked dirty and
   * the tiles are lost on restart.
   */
  seenBits(record: PlayerRecord, place: Place, tileCount: number): Uint8Array {
    return ensure(record.seen, placeKey(place), tileCount);
  }

  /**
   * Folds newly lit tiles into the persistent set.
   *
   * Returns exactly the tiles that were *not* already seen, which is the `seenDelta` payload: the
   * server ships what it just added, so the client's copy stays identical to the authoritative one
   * without ever deriving visibility from its own predicted position.
   */
  markSeen(record: PlayerRecord, place: Place, tileCount: number, tiles: Iterable<number>): number[] {
    const added = bitsetAddAll(this.seenBits(record, place, tileCount), tiles);
    if (added.length > 0) this.touch(record);
    return added;
  }

  /**
   * Records that this character has collected a ground pickup.
   *
   * Returns whether it was new, so a caller cannot pick the same torch up twice by arriving on its
   * tile from two directions in consecutive ticks — the second call is a no-op and says so, rather
   * than announcing a find and re-equipping a light that is already in hand.
   */
  markTaken(record: PlayerRecord, key: string): boolean {
    if (record.taken.has(key)) return false;
    record.taken.add(key);
    this.touch(record);
    return true;
  }

  hasTaken(record: PlayerRecord, key: string): boolean {
    return record.taken.has(key);
  }

  /**
   * Records the timed effects worth keeping, dropping the ones flagged `NoSave`.
   *
   * The filter is here rather than at the call site so that no caller can persist something that asked
   * not to be — the rest cycle's affects are situational and cheap to re-earn, and banking one across
   * a reconnect would be a way to skip the half-minute they cost.
   *
   * Called whenever a savable affect *changes* and again as the connection closes, which is what makes
   * the stored durations honest: between those two points they are counting down in the simulation and
   * nothing here hears about it. A save written by the debounce in between is therefore stale-high, and
   * a hard kill (no close, no signal) resumes with a slightly fuller torch than was earned. Touching
   * the record every tick to close that gap would rewrite the file ten times a second for numbers
   * nobody reads until login.
   *
   * Copied on the way in. The simulation mutates `durationMs` in place every tick, so holding the same
   * objects would have the debounced write race the countdown and — worse — make the comparison below
   * always find the two lists identical.
   */
  setAffects(record: PlayerRecord, affects: readonly Affect[]): void {
    const keep = affects.filter((affect) => !hasFlag(affect, AffectFlag.NoSave)).map((affect) => ({ ...affect }));
    if (sameAffects(record.affects, keep)) return;
    record.affects = keep;
    this.touch(record);
  }

  setLastRoom(record: PlayerRecord, room: RoomId): void {
    if (record.lastRoom === room) return;
    record.lastRoom = room;
    this.touch(record);
  }

  /**
   * Records the level reached and the experience held. See {@link PlayerRecord.progress}.
   *
   * Sanitised the way the loader would: the level clamped to the game's own band, both rounded,
   * and the brand-new-character pair collapsing to "nothing recorded". Callers pass what the live
   * character holds; this decides whether that is worth a byte.
   */
  setProgress(record: PlayerRecord, level: number, experience: number, maxHp?: number): void {
    const cleanLevel = Number.isFinite(level) ? Math.min(60, Math.max(1, Math.round(level))) : 1;
    const cleanExperience = Number.isFinite(experience) ? Math.max(0, Math.round(experience)) : 0;
    // **Hit points are stored, not derived** (Phase 14b). They are rolled once per level, so a
    // formula cannot reproduce them — and a character's maximum must not change because a function
    // did. Absent leaves whatever was already recorded, so a caller that does not know about hit
    // points cannot erase them.
    const cleanMaxHp =
      typeof maxHp === 'number' && Number.isFinite(maxHp) ? Math.max(1, Math.round(maxHp)) : record.progress?.maxHp;
    // A level-1 character with nothing banked is the default, and writing it down says nothing —
    // *unless* they have hit points worth remembering, which a rolled starting kit means they might.
    const value =
      cleanLevel === 1 && cleanExperience === 0 && cleanMaxHp === undefined
        ? undefined
        : { level: cleanLevel, experience: cleanExperience, ...(cleanMaxHp === undefined ? {} : { maxHp: cleanMaxHp }) };

    const current = record.progress;
    if (current === value) return;
    if (
      current &&
      value &&
      current.level === value.level &&
      current.experience === value.experience &&
      current.maxHp === value.maxHp
    ) {
      return;
    }
    record.progress = value;
    this.touch(record);
  }

  /** Records what a character is wearing. See {@link PlayerRecord.equipped}. */
  setEquipped(record: PlayerRecord, equipped: Equipped): void {
    const next = JSON.stringify(equipped);
    if (JSON.stringify(record.equipped ?? {}) === next) return;
    record.equipped = readEquipped(JSON.parse(next));
    this.touch(record);
  }

  /**
   * Records what a character is carrying. See {@link PlayerRecord.inventory}.
   *
   * Round-tripped through `readInventory` rather than stored by reference, for the reason
   * {@link setEquipped} does it: the record must not alias live simulation state, or a later mutation
   * of the bag would edit what is about to be written without ever marking it dirty.
   */
  setInventory(record: PlayerRecord, inventory: Inventory): void {
    const next = JSON.stringify(inventory);
    if (JSON.stringify(record.inventory ?? emptyInventory()) === next) return;
    record.inventory = readInventory(JSON.parse(next), readItem);
    this.touch(record);
  }

  /**
   * Records how far below full each pool is.
   *
   * Takes current and max and stores the *difference*, so the caller cannot accidentally persist the
   * value — see {@link PlayerRecord.missing} for why that distinction is the whole point. Rounded,
   * because a fractional wound is not worth a byte, and floored at zero so a pool somehow above its
   * maximum is recorded as unhurt rather than as a negative wound that would heal on load.
   */
  setMissing(
    record: PlayerRecord,
    pools: {
      readonly hp: number; readonly maxHp: number;
      readonly mana: number; readonly maxMana: number;
      readonly move: number; readonly maxMove: number;
    },
  ): void {
    const next = {
      hp: Math.max(0, Math.round(pools.maxHp - pools.hp)),
      mana: Math.max(0, Math.round(pools.maxMana - pools.mana)),
      move: Math.max(0, Math.round(pools.maxMove - pools.move)),
    };
    const unhurt = next.hp === 0 && next.mana === 0 && next.move === 0;
    const value = unhurt ? undefined : next;

    const current = record.missing;
    if (current === value) return;
    if (current && value && current.hp === value.hp && current.mana === value.mana && current.move === value.move) {
      return;
    }
    record.missing = value;
    this.touch(record);
  }

  /**
   * Converts a pre-v4 `explored` room list into seen tiles.
   *
   * The old model revealed a room's own floor plus the corridor stubs leading out of it, which is
   * precisely what `legacyRoomReveal` reproduces — so this is a faithful translation rather than a
   * guess, and a returning character keeps the map they walked. When the `explored` field is finally
   * dropped from {@link StoredRecord}, this method and `legacy-fog.ts` go together.
   */
  private migrateExplored(record: PlayerRecord, rooms: readonly number[], slug: string): void {
    const resolveRoom = this.resolveLegacyRoom;
    if (!resolveRoom) {
      console.warn(
        `[players] ${slug}: discarding ${rooms.length} pre-v4 explored rooms — ` +
          `no world loaded to map them onto. The character starts with an unseen map.`,
      );
      return;
    }

    let migrated = 0;
    for (const id of rooms) {
      const room = resolveRoom(id as RoomId);
      // A room from a zone this server no longer loads. Skipped rather than fatal: the world's zone
      // list is configuration and may legitimately have shrunk since the save was written.
      if (!room) continue;
      bitsetAddAll(ensure(record.seen, placeKey(room.place), room.tileCount), room.tiles);
      migrated++;
    }

    console.log(
      `[players] ${slug}: migrated ${String(migrated).padStart(4)} of ` +
        `${String(rooms.length).padStart(4)} pre-v4 explored rooms to ${seenTileCount(record)} seen tiles`,
    );
    // Dirty even when nothing converted, so the obsolete field is dropped from the file rather than
    // being re-read and re-warned about on every login.
    this.touch(record);
  }

  private touch(record: PlayerRecord): void {
    const slug = slugify(record.name);
    if (!slug) return;
    const existing = this.timers.get(slug);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(slug);
      this.flush(record);
    }, SAVE_DEBOUNCE_MS);
    // Do not hold the process open just to write a seen map.
    timer.unref?.();
    this.timers.set(slug, timer);
  }

  /** Writes immediately, cancelling any pending debounce. */
  flush(record: PlayerRecord): void {
    const slug = slugify(record.name);
    if (!slug) return;
    const pending = this.timers.get(slug);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(slug);
    }
    const seen: Record<string, string> = {};
    for (const [key, bits] of record.seen) seen[key] = bitsToBase64(bits);
    const stored: StoredRecord = {
      name: record.name,
      seen,
      // Insertion order, which is the order they were found in. Not sorted: the order a character
      // picked things up in is mildly interesting when reading a save by hand, and sorting would
      // reshuffle the whole array every time a low-numbered room was emptied.
      taken: [...record.taken],
      // Omitted rather than written as an empty array, so an unaffected character's file says nothing
      // about affects at all. `warned` is dropped — see {@link StoredAffect}.
      ...(record.affects.length === 0
        ? {}
        : {
            affects: record.affects.map((affect) => ({
              type: affect.type,
              durationMs:
                affect.durationMs === UNLIMITED_DURATION ? UNLIMITED_DURATION : Math.round(affect.durationMs),
              apply: affect.apply,
              modifier: affect.modifier,
              flags: affect.flags,
              // Omitted rather than written as `undefined` — `exactOptionalPropertyTypes` is on, and a
              // JSON file with `"context": null` in it would read back as an id nothing can resolve.
              ...(affect.context === undefined ? {} : { context: affect.context }),
            })),
          }),
      ...(record.lastRoom === undefined ? {} : { lastRoom: record.lastRoom }),
      ...(record.missing === undefined ? {} : { missing: record.missing }),
      ...(record.progress === undefined
        ? {}
        : {
            level: record.progress.level,
            experience: record.progress.experience,
            ...(record.progress.maxHp === undefined ? {} : { maxHp: record.progress.maxHp }),
          }),
      // Absent on a character wearing nothing, which no live character is — but a hand-edited save
      // might be, and an empty object on disk says less than no key at all.
      ...(record.equipped && Object.keys(record.equipped).length > 0 ? { equipped: record.equipped } : {}),
      // Written whenever the bag is non-default, which includes an *empty* bag with a raised capacity —
      // that is a fact about the character even though it holds nothing. A character who has never
      // picked anything up writes no key at all.
      ...(record.inventory &&
      (record.inventory.stacks.length > 0 || record.inventory.capacity !== STARTING_CAPACITY)
        ? { inventory: record.inventory }
        : {}),
      savedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(join(this.dir, `${slug}.json`), JSON.stringify(stored));
    } catch (err) {
      console.error(`[players] could not save ${slug}:`, (err as Error).message);
    }
  }

  flushAll(): void {
    for (const record of this.records.values()) this.flush(record);
  }

  /**
   * Every character on disk, summarised. For the admin roster.
   *
   * **The cache wins over the file.** A loaded record may be ahead of its debounced write, and a
   * roster that showed the stale file would have an admin "fix" an edit that already happened. The
   * file still supplies `savedAt` — the record does not carry one, because the write time is a fact
   * about the file.
   *
   * A file whose stored name does not slugify back to its own filename is skipped with a warning
   * rather than listed: `load` keys on the *name*, so such a file can never be coherently loaded, and
   * offering it in a roster would offer edits that land somewhere else. Hand-editing is how one
   * arises, and the warning says which file to fix.
   */
  list(): StoredSummary[] {
    const out: StoredSummary[] = [];
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return out;
    }
    for (const file of files) {
      const slug = file.slice(0, -'.json'.length);
      let stored: StoredRecord;
      try {
        stored = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as StoredRecord;
      } catch {
        console.warn(`[players] ${file}: unreadable, skipped from the roster`);
        continue;
      }
      const name = typeof stored.name === 'string' && stored.name.length > 0 ? stored.name : slug;
      if (slugify(name) !== slug) {
        console.warn(
          `[players] ${file}: stored name "${name}" does not match its filename — ` +
            `fix the file by hand; it cannot be loaded under either identity`,
        );
        continue;
      }
      const savedAt = typeof stored.savedAt === 'string' ? stored.savedAt : undefined;
      const cached = this.records.get(slug);
      if (cached) {
        out.push({
          slug,
          name: cached.name,
          savedAt,
          lastRoom: cached.lastRoom,
          seenTiles: seenTileCount(cached),
          takenCount: cached.taken.size,
          affectCount: cached.affects.length,
          wound: cached.missing ? { ...cached.missing } : undefined,
          level: cached.progress?.level,
        });
        continue;
      }
      // Decoded with the same functions `load` uses, so a malformed field counts as what it would
      // load as — but deliberately not cached: a roster read must not populate the cache with
      // records nothing is playing.
      const record: PlayerRecord = {
        name,
        seen: decodeSeen(stored.seen),
        taken: decodeTaken(stored.taken),
        affects: decodeAffects(stored, 0),
        lastRoom: stored.lastRoom,
        missing: decodeMissing(stored.missing),
        progress: decodeProgress(stored.level, stored.experience, stored.maxHp),
        equipped: readEquipped(stored.equipped),
        inventory: stored.inventory === undefined ? undefined : readInventory(stored.inventory, readItem),
      };
      out.push({
        slug,
        name,
        savedAt,
        lastRoom: record.lastRoom,
        seenTiles: seenTileCount(record),
        takenCount: record.taken.size,
        affectCount: record.affects.length,
        wound: record.missing,
        level: record.progress?.level,
      });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Sets the stored wound directly — the admin's offline vitals editor.
   *
   * {@link setMissing} takes pools and maxima because its caller holds a live character; an offline
   * record has neither, only the deficit itself, so this is the same fact accepted in the shape the
   * file already stores it. Sanitised exactly as the loader would: rounded, floored at zero, and
   * all-zero collapsing to "unhurt".
   */
  setWound(record: PlayerRecord, wound: { hp?: number; mana?: number; move?: number } | undefined): void {
    const clean = (v: number | undefined): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
    const next = wound ? { hp: clean(wound.hp), mana: clean(wound.mana), move: clean(wound.move) } : undefined;
    const value = next && (next.hp > 0 || next.mana > 0 || next.move > 0) ? next : undefined;

    const current = record.missing;
    if (current === value) return;
    if (current && value && current.hp === value.hp && current.mana === value.mana && current.move === value.move) {
      return;
    }
    record.missing = value;
    this.touch(record);
  }

  /**
   * Forgets every ground pickup this character has collected, and says how many.
   *
   * The tester's "give me my torches back": pickups are per-character facts (see `pickups.ts`), so
   * clearing the set makes every room offer its find again — for this character and nobody else.
   * Safe while online for the same reason: `hasTaken` reads this set at walk time.
   */
  clearTaken(record: PlayerRecord): number {
    const count = record.taken.size;
    if (count === 0) return 0;
    record.taken.clear();
    this.touch(record);
    return count;
  }

  /**
   * Removes a character: the cached record, any pending write, and the file.
   *
   * Returns whether a file was actually deleted. The cache is evicted even when no file exists, so
   * a character created this session and never flushed is gone too — the next `load` of the name
   * starts blank, which is the whole meaning of deletion here.
   *
   * The caller is responsible for refusing this while the character is online: the store cannot see
   * connections, and deleting under a live session would have the disconnect faithfully write the
   * whole record straight back.
   */
  delete(name: string): boolean {
    const slug = slugify(name);
    if (!slug) return false;
    const pending = this.timers.get(slug);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(slug);
    }
    this.records.delete(slug);
    try {
      unlinkSync(join(this.dir, `${slug}.json`));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The bitset for a Place, grown if the grid it is indexed against is larger than the stored one.
 *
 * A saved bitset is only as long as the grid was when it was written, and a decoded one is only as
 * long as its base64. Growing on first use keeps every later write in bounds. It does *not* pretend
 * to re-map a bitset onto a grid of a different width — tile indices are row-major, so regenerating
 * a zone into a wider grid shifts every one of them. That invalidates saved maps by construction;
 * all this guarantees is that it degrades into a wrong-looking map rather than an out-of-range write.
 */
function ensure(seen: Map<string, Uint8Array>, key: string, tileCount: number): Uint8Array {
  const needed = bitsetBytes(tileCount);
  const existing = seen.get(key);
  if (existing && existing.length >= needed) return existing;
  const grown = createBitset(tileCount);
  if (existing) grown.set(existing.subarray(0, Math.min(existing.length, grown.length)));
  seen.set(key, grown);
  return grown;
}

function decodeSeen(stored: Record<string, string> | undefined): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!stored || typeof stored !== 'object') return out;
  for (const [key, bits] of Object.entries(stored)) {
    if (typeof bits !== 'string') continue;
    // Decoded at its own natural length rather than a grid's: the grid for a Place is built lazily
    // and may not exist yet at load time. `ensure` resizes on first use, once the size is known.
    out.set(key, bitsFromBase64(bits, base64Bytes(bits)));
  }
  return out;
}

/**
 * Reads the taken set back, tolerating anything.
 *
 * A save written before v5 simply has no `taken` field, and the empty set that produces is exactly
 * right: that character has taken nothing, so every room they walk back into offers its pickup
 * again. No migration is needed and none is possible — the old saves record no such thing.
 */
function decodeTaken(stored: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(stored)) return out;
  for (const key of stored as unknown[]) {
    if (typeof key === 'string' && key.length > 0) out.add(key);
  }
  return out;
}

/**
 * How long ago a save was written, in milliseconds, or 0 if it will not say.
 *
 * Only the `Offline` flag reads this, and an unparseable or future timestamp yields 0 — which means
 * "no time passed", the conservative answer. Losing a cooldown's worth of countdown because a clock
 * went backwards is a small unfairness; handing out a negative elapsed time would *extend* every
 * offline affect, which is the exploitable direction.
 */
function elapsedSince(savedAt: string | undefined): number {
  if (typeof savedAt !== 'string') return 0;
  const then = Date.parse(savedAt);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Date.now() - then);
}

/**
 * The stored affect list, shape-checked, plus the pre-v9 carried light.
 *
 * Every field is validated against its catalogue rather than trusted, and the reason is that this file
 * is hand-editable: a `type` of `"suepr_strength"` or an `apply` of `"godmode"` has to produce a
 * character with one fewer affect, not a record that feeds a stat nothing derives or a `NaN` that
 * propagates into a pool and makes every later comparison false.
 *
 * ## The offline clock
 *
 * A saved duration resumes with exactly the time it had — the default is that logging out **pauses**
 * an affect, which is how the carried light has always behaved and what a player expects of a torch
 * they were not holding. Affects flagged `Offline` are the opt-out and have `elapsedMs` deducted here,
 * expiring outright if that used them up. That flag has no setter yet; it is the seam that stops a
 * later cooldown or PvP timer from being dodged by closing the tab, and the alternative to putting it
 * in now is a special case in this loader later.
 */
function decodeAffects(stored: StoredRecord, elapsedMs: number): Affect[] {
  const out: Affect[] = [];

  if (Array.isArray(stored.affects)) {
    for (const raw of stored.affects as unknown[]) {
      const affect = decodeAffect(raw, elapsedMs);
      if (affect) out.push(affect);
    }
    return out;
  }

  // Pre-v9: the carried light as two fields of its own. Converted rather than discarded, for the same
  // reason `explored` was — refusing to read an old save locks a character out of their own map over a
  // data format. A light with no id is nothing at all, which is the right reading of a missing field.
  const id = typeof stored.light === 'string' && stored.light.length > 0 ? stored.light : undefined;
  if (id === undefined) return out;
  const remaining =
    typeof stored.lightRemainingMs === 'number' && Number.isFinite(stored.lightRemainingMs)
      ? Math.max(0, stored.lightRemainingMs)
      : UNLIMITED_DURATION;
  out.push(
    newAffect({
      type: 'light',
      durationMs: remaining,
      apply: 'light',
      flags: AffectFlag.NoShow,
      context: id,
    }),
  );
  return out;
}

const APPLY_SET = new Set<string>(APPLY_LOCATIONS);

function decodeAffect(raw: unknown, elapsedMs: number): Affect | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;

  const type = typeof value.type === 'string' ? value.type : '';
  // A type the catalogue no longer knows is dropped: content can be removed between one login and the
  // next, and the right answer to "you were affected by something that no longer exists" is that you
  // are not affected by it.
  if (!affectKind(type)) return undefined;

  const apply = typeof value.apply === 'string' && APPLY_SET.has(value.apply) ? (value.apply as ApplyLocation) : 'none';
  const modifier = typeof value.modifier === 'number' && Number.isFinite(value.modifier) ? value.modifier : 0;
  const flags = typeof value.flags === 'number' && Number.isFinite(value.flags) ? Math.trunc(value.flags) : 0;
  const context = typeof value.context === 'string' && value.context.length > 0 ? value.context : undefined;

  const savedDuration = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) ? value.durationMs : 0;
  let durationMs = savedDuration === UNLIMITED_DURATION ? UNLIMITED_DURATION : Math.max(0, savedDuration);
  if (durationMs !== UNLIMITED_DURATION && (flags & AffectFlag.Offline) !== 0) {
    durationMs -= elapsedMs;
    // It ran out while nobody was watching. Dropped rather than restored at zero, so no expiry event
    // fires for something that lapsed in a previous session.
    if (durationMs <= 0) return undefined;
  }

  return newAffect({
    type: type as AffectType,
    durationMs,
    apply,
    modifier,
    flags,
    ...(context === undefined ? {} : { context }),
  });
}

/**
 * Whether two affect lists are the same fact, for deciding if a save is needed.
 *
 * Order-sensitive, and that is fine: the simulation only ever appends and splices whole runs, so two
 * lists that differ in order differ in what happened. Comparing as sets would cost a sort on every
 * light change to catch a case that cannot arise.
 */
function sameAffects(a: readonly Affect[], b: readonly Affect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, i) => {
    const right = b[i]!;
    return (
      left.type === right.type &&
      left.durationMs === right.durationMs &&
      left.apply === right.apply &&
      left.modifier === right.modifier &&
      left.flags === right.flags &&
      left.context === right.context
    );
  });
}

/**
 * The stored level and experience, shape-checked.
 *
 * The same defensive posture as everything else here — the file is hand-editable, and
 * `"level": "big"` has to produce a character with no recorded progress rather than a NaN that
 * derives NaN hit points. A level outside the game's own band is clamped rather than dropped:
 * somebody who hand-wrote 99 meant "high", not "forget my level". The brand-new pair reads as
 * nothing recorded, mirroring what {@link PlayerStore.setProgress} writes.
 */
function decodeProgress(
  level: unknown,
  experience: unknown,
  maxHp?: unknown,
): { level: number; experience: number; maxHp?: number } | undefined {
  if (typeof level !== 'number' || !Number.isFinite(level)) return undefined;
  const cleanLevel = Math.min(60, Math.max(1, Math.round(level)));
  const cleanExperience =
    typeof experience === 'number' && Number.isFinite(experience) ? Math.max(0, Math.round(experience)) : 0;
  // Absent on every record written before Phase 14b, which is why the restore falls back to the
  // level's expected average rather than treating it as a character with no hit points at all.
  const cleanMaxHp =
    typeof maxHp === 'number' && Number.isFinite(maxHp) ? Math.max(1, Math.round(maxHp)) : undefined;
  if (cleanLevel === 1 && cleanExperience === 0 && cleanMaxHp === undefined) return undefined;
  return { level: cleanLevel, experience: cleanExperience, ...(cleanMaxHp === undefined ? {} : { maxHp: cleanMaxHp }) };
}

/**
 * The stored wound, shape-checked.
 *
 * Absent, malformed or negative all mean the same thing — unhurt. This file is hand-editable, and a
 * `missing` of `{"hp": "lots"}` has to produce a healthy character rather than a `NaN` that propagates
 * into the pool and makes every subsequent comparison false.
 */
function decodeMissing(stored: unknown): { hp: number; mana: number; move: number } | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;
  const raw = stored as Record<string, unknown>;
  const read = (key: string): number => {
    const value = raw[key];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  };
  const missing = { hp: read('hp'), mana: read('mana'), move: read('move') };
  // Nothing missing is the same as no record of anything missing, and writing zeroes into every save
  // would grow the file for no information.
  if (missing.hp === 0 && missing.mana === 0 && missing.move === 0) return undefined;
  return missing;
}

/** How many bytes a base64 string decodes to, ignoring padding and anything outside the alphabet. */
function base64Bytes(s: string): number {
  let chars = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 61 /* = */) break;
    const alphabetic =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 /* + */ ||
      code === 47 /* / */;
    if (alphabetic) chars++;
  }
  return (chars * 6) >> 3;
}
