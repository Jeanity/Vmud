/**
 * Authored mobs — the overlay the panel writes over the harvested templates. **A4c.**
 *
 * Owner's ask, 2026-08-04: *"assign items to mobs as loot."* A4 built the live half — spawn one,
 * watch it, slay it and see what its corpse holds — and this is the authoring half.
 *
 * The same shape `item-overrides.ts` gave items and `overrides.ts` gave rooms, for the same
 * governing rule (`DESIGN-admin-panel.md` §1): **authoring lands as overlay files the game loads**,
 * never as edits to generated data. `data/world/spawns/*.json` is a build output of
 * `npm run worldgen`, so a kit edited there would be undone by the next harvest.
 *
 * ## Per template, and it has to be said out loud
 *
 * A harvested kit does **not** live on the template — it comes from the zone's reset table, where an
 * `E` or a `G` attaches to *the last mobile loaded* (`reset.ts`). So the same vnum placed in two rooms
 * can be carrying two different things, because two different reset commands dressed it.
 *
 * What this file authors is the other thing: loot on the **template**, which every instance of that
 * vnum gets wherever it spawns. That is the useful shape for *"give kobold guards a rusty key"* and it
 * is also the surprising one, so the panel says it in as many words: **authoring this changes every
 * kobold guard the world spawns**, not the one you were looking at.
 *
 * ## Additive, never a replacement
 *
 * Authored loot is applied **on top of** whatever the reset table dressed the mob in. It cannot take a
 * harvested piece away, and that is deliberate: subtraction would mean this overlay had to name things
 * that are not in it, and a re-harvest that changed a zone's `E` list would silently change what the
 * subtraction meant. Adding is a statement that stays true no matter what moves underneath it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EQUIP_SLOTS,
  attackBonusFor,
  isSpellId,
  parseDice,
  roundLengthFor,
  type EquipSlot,
  type Item,
  type ItemTemplate,
  type MobTemplate,
  type SpellId,
} from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where authored mobs live — beside `rooms.json` and `items.json`, and exported for the same reason. */
export const MOBS_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'mobs.json');

/**
 * One thing this mob is authored to have.
 *
 * `slot` decides worn against carried, and it is the **author's** choice rather than the item's:
 * `reset.ts` makes exactly the same distinction for a harvested `E`, where the wear position comes
 * from the command and not from the item's own bits, *"because a ring on the left hand is
 * `WEAR_FINGER_L`, and no wear flag distinguishes left from right"*. An item with no slot named is
 * carried, which is what a `G` does.
 */
export interface AuthoredLoot {
  readonly vnum: number;
  readonly slot?: EquipSlot;
}

/**
 * What an author may change about a mob — its kit (A4c) and, since **A9**, what it *is*.
 *
 * Every field is optional and the record is a **patch**, the shape `ItemOverride` has: authoring a name
 * leaves the level alone, and clearing one restores the harvest because {@link applyMobOverride} is always
 * applied to the pristine template rather than to an already-overridden one.
 *
 * ## The rule A4c had to put on screen applies here word for word
 *
 * An edit is **per template**. It changes every instance the world spawns from now on and **none** of the
 * ones already standing, because a mob is built from its template once, at spawn. Editing a kobold guard's
 * level does nothing to the ninety-three kobold guards currently on their feet — A4's Repop is what turns
 * an edit into something you can walk over and look at.
 *
 * ## Three of these are the combat scale
 *
 * {@link level}, {@link hp} and {@link damage} are the numbers `DESIGN-progression.md` §8 and Phase 14b
 * calibrated the whole fight against — six to eight rounds for a same-level fight, and a level-1 character
 * who can win somewhere. **This is therefore also the fastest way to make a zone unwinnable**, which is a
 * real power to hand an operator and one the panel states rather than let somebody discover.
 *
 * ## What is deliberately not here: aggression
 *
 * The roadmap row lists it, and it is left out on purpose rather than forgotten. Aggression is not a field
 * but a rule — disposition, clauses, reaction time, memory, sentinel and assists — and `matchesAggro` can
 * evaluate exactly one of its clauses today: `all`. The rest need alignment and race, which arrive with
 * Phase 21. A dropdown that set `disposition: 'aggressive'` with no clause under it would produce a mob
 * marked hostile that never attacks anybody, which is an editor that lies to the person using it.
 */
export interface MobOverride {
  readonly loot?: readonly AuthoredLoot[];
  /** How it is referred to in a sentence: *“a sentry”*, *“Masha the dicer”*. Carries colour codes. */
  readonly name?: string;
  /**
   * How it reads standing in a room: *“A snooty merchant's wife is here admiring the decor.”*
   *
   * Authorable beside the name because the two are one thought. A rename without it leaves the mob
   * introducing itself by its old sentence, which is an editor that half-works.
   */
  readonly room?: string;
  /** What it answers to. Authoring these changes what a player can type at it. */
  readonly keywords?: readonly string[];
  /** 1–{@link MAX_AUTHORED_LEVEL}, the band the experience table and the round clock are defined over. */
  readonly level?: number;
  /** Hit points as **dice**, `"23d44+207"` — rolled per instance, so two guards are not equally tough. */
  readonly hp?: string;
  /** What it hits for, as dice. Folded into the derived `combat`, which is where the fight reads it. */
  readonly damage?: string;
  /** Armour class on **our** ascending SRD scale, not Duris' descending one. See `armourToAc`. */
  readonly armourClass?: number;
  /** What killing it is worth. The pool `divideExperience` shares out. */
  readonly experience?: number;
  /** The hit points below which it breaks off and runs. **0 is a mob that never runs**, which is most. */
  readonly wimpyAt?: number;
  /** Which body it is drawn with — an art key, the same vocabulary `spriteFor` produces. */
  readonly sprite?: string;
  /**
   * The spells it casts in a fight — Phase 20 slice 3, the field that turns a shaman's name into
   * behaviour. Whole-name spell ids from the shared registry; an unknown id is dropped by the loader
   * for the reason every sibling field is validated: a hand-typed spell nothing implements would be
   * a mob that winds up and casts silence, in the wrong sense of the word.
   */
  readonly spells?: readonly SpellId[];
  /** When it was last written, so the panel can say how stale it is. */
  readonly at?: string;
  /** Who or what wrote it — the provenance every overlay here records. */
  readonly by?: string;
}

/** The fields that are *about* an override rather than part of one. See `ITEM_OVERRIDE_META`. */
export const MOB_OVERRIDE_META: readonly string[] = ['at', 'by'];

/**
 * Whether an override still authors anything, or is only metadata left behind by a revert.
 *
 * A4c gated on `loot` alone, which was right while loot was all there was; with A9 that would drop every
 * stats-only edit on the next save. Same rule rooms and items keep: an empty record is not an authored
 * mob, it is the ghost of one having been edited and then emptied.
 */
export function mobAuthorsAnything(override: MobOverride): boolean {
  return Object.entries(override).some(([key, value]) => {
    if (MOB_OVERRIDE_META.includes(key)) return false;
    // **An empty loot list authors nothing**, and it is the one field where present and meaningful come
    // apart: every other field here is a scalar, so having it *is* saying something, while `loot: []` is
    // what a kit somebody emptied leaves behind. A4c's saver made the same distinction by hand; keeping
    // it here is what lets one predicate serve the loader, the saver and the merge.
    return Array.isArray(value) ? value.length > 0 : true;
  });
}

/** The band levels live in — `experienceToLevel`'s own, and what the round clock is defined over. */
export const MAX_AUTHORED_LEVEL = 60;
/** Ascending SRD armour class. `armourToAc` lands the harvest in roughly 1–22; this is headroom. */
export const MAX_AUTHORED_AC = 40;
/** A ceiling on the experience pool, so one typed zero cannot hand out forty levels in a kill. */
export const MAX_AUTHORED_EXPERIENCE = 10_000_000;
/** A ceiling on a wimpy threshold. The source's own rule is `level * 6`, so this is generous. */
export const MAX_AUTHORED_WIMPY = 100_000;

/**
 * Reads a whole number inside a bound, or nothing.
 *
 * **Clamped rather than refused**, unlike the router's own validator, because the two read different
 * things: this reads a file somebody may have hand-edited, where the useful posture is the one every
 * sibling loader takes — salvage what is meant. The router reads a form, where a number out of range is a
 * mistake somebody can still fix and saying so is worth more than silently changing it.
 */
function readBounded(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

/** A dice expression the game can actually roll, trimmed — or nothing. */
function readDiceString(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !parseDice(raw.trim())) return undefined;
  return raw.trim();
}

/** One authored word list, lowercased and de-duplicated. Empty means nothing was authored. */
function readWords(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const words = (raw as unknown[])
    .filter((w): w is string => typeof w === 'string')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
  return words.length > 0 ? [...new Set(words)] : undefined;
}

/** One authored line of prose, trimmed — or nothing. */
/** A well-formed spell list, or nothing: known ids only, deduplicated, capped where sanity lives. */
function readSpellList(raw: unknown): readonly SpellId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const spells = [...new Set((raw as unknown[]).filter((id): id is SpellId => typeof id === 'string' && isSpellId(id)))];
  if (spells.length === 0) return undefined;
  return spells.slice(0, 8);
}

function readProse(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  return raw.trim();
}

/**
 * A template with an override folded over it — **A9**. Returns a **new** template.
 *
 * Applied to the *pristine* harvested template and never to an already-overridden one, which is what lets
 * clearing a field genuinely restore the harvest; the caller keeps the pristine copy, exactly as
 * `applyItemOverride` requires.
 *
 * **`combat` is re-derived rather than patched**, and that is the one subtle part. A template stores the
 * *derived* profile — `armourClass`, `damage`, `attackBonus`, `roundMs` — rather than the raw columns it
 * came from, and two of those are functions of the **level**. Authoring a level and leaving `combat` alone
 * would produce a level-40 kobold swinging with a level-3's accuracy. Everything not authored is carried
 * through unchanged, so an edit to the name touches nothing about the fight.
 *
 * `attackBonusFor` is called without `martial` because nothing harvested is martial: the source's branch is
 * `IS_WARRIOR || IS_GREATER_RACE || IS_ELITE || IS_GIANT` and none of those four columns are read, so
 * `readCombatStats` takes the lesser branch for every mob in the world. The day class is harvested this
 * becomes the same one-line change `combat.ts` already promises.
 */
export function applyMobOverride(template: MobTemplate, override: MobOverride): MobTemplate {
  const level = override.level ?? template.level;
  const damage = override.damage === undefined ? undefined : parseDice(override.damage);
  return {
    ...template,
    ...(override.name !== undefined ? { name: override.name } : {}),
    ...(override.room !== undefined ? { room: override.room } : {}),
    ...(override.keywords !== undefined ? { keywords: override.keywords } : {}),
    ...(override.level !== undefined ? { level } : {}),
    ...(override.hp !== undefined ? { hp: override.hp } : {}),
    ...(override.experience !== undefined ? { experience: override.experience } : {}),
    ...(override.wimpyAt !== undefined ? { wimpyAt: override.wimpyAt } : {}),
    ...(override.sprite !== undefined ? { sprite: override.sprite } : {}),
    ...(override.spells !== undefined ? { spells: override.spells } : {}),
    combat: {
      ...template.combat,
      ...(override.armourClass !== undefined ? { armourClass: override.armourClass } : {}),
      ...(damage ? { damage } : {}),
      // Both of these are functions of the level, so they move with it or the edit is half-applied.
      attackBonus: attackBonusFor(level),
      roundMs: roundLengthFor(level),
    },
  };
}

/**
 * The current override with a patch laid over it and some fields cleared — or nothing left to author.
 *
 * `mergeItemOverride`'s twin, down to returning `undefined` for an emptied record: the caller deletes the
 * entry rather than storing `{}`, which is what takes the authored mark off the row.
 */
export function mergeMobOverride(
  current: MobOverride | undefined,
  next: Partial<MobOverride>,
  cleared: readonly string[],
  at: string,
): MobOverride | undefined {
  const merged: Record<string, unknown> = { ...(current ?? {}), ...next, at };
  for (const key of cleared) delete merged[key];
  const override = merged as MobOverride;
  return mobAuthorsAnything(override) ? override : undefined;
}

export type MobOverrides = Map<number, MobOverride>;

/** The most pieces one template may be authored to carry. */
export const MAX_AUTHORED_LOOT = 12;

const SLOT_SET = new Set<string>(EQUIP_SLOTS);

/**
 * Reads one loot row, or nothing.
 *
 * A slot the game does not model is **refused rather than downgraded to carried**, which is the
 * opposite of what `reset.ts` does with a harvested `E` — and the asymmetry is right. A harvested
 * position we do not model is *data we inherited* and throwing the item away would lose content, so it
 * goes into the mob's hands. A slot typed here is *a choice somebody just made*, and silently doing
 * something else with it is how an author ends up believing a hat is on a head it is not on.
 */
function readLoot(raw: unknown): AuthoredLoot | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row.vnum !== 'number' || !Number.isInteger(row.vnum)) return undefined;
  if (row.slot === undefined || row.slot === null || row.slot === '') return { vnum: row.vnum };
  if (typeof row.slot !== 'string' || !SLOT_SET.has(row.slot)) return undefined;
  return { vnum: row.vnum, slot: row.slot as EquipSlot };
}

/**
 * Reads the overlay, tolerating anything — the same posture as every sibling loader.
 *
 * A malformed row is dropped rather than guessed at, because a mob spawning with `undefined` in an
 * equipment slot fails somewhere else entirely: the paper doll, the corpse, the armour fold.
 */
export function loadMobOverrides(file = MOBS_FILE): MobOverrides {
  const out: MobOverrides = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No overlay is the ordinary case — nothing has been authored yet.
    return out;
  }
  if (typeof raw !== 'object' || raw === null) return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const vnum = Number(key);
    if (!Number.isInteger(vnum) || typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const loot = Array.isArray(record.loot)
      ? (record.loot as unknown[]).map(readLoot).filter((row): row is AuthoredLoot => row !== undefined)
      : undefined;
    const keywords = readWords(record.keywords);
    const level = readBounded(record.level, 1, MAX_AUTHORED_LEVEL);
    const armourClass = readBounded(record.armourClass, 0, MAX_AUTHORED_AC);
    const experience = readBounded(record.experience, 0, MAX_AUTHORED_EXPERIENCE);
    const wimpyAt = readBounded(record.wimpyAt, 0, MAX_AUTHORED_WIMPY);
    // Dice are validated by **parsing** them rather than against a pattern: `parseDice` is what the game
    // itself will call, so anything it refuses is a mob that swings for `NaN` or has no hit points at all.
    const hp = readDiceString(record.hp);
    const damage = readDiceString(record.damage);
    const override: MobOverride = {
      ...(loot && loot.length > 0 ? { loot: loot.slice(0, MAX_AUTHORED_LOOT) } : {}),
      ...(readProse(record.name) === undefined ? {} : { name: readProse(record.name)! }),
      ...(readProse(record.room) === undefined ? {} : { room: readProse(record.room)! }),
      ...(keywords ? { keywords } : {}),
      ...(level === undefined ? {} : { level }),
      ...(hp === undefined ? {} : { hp }),
      ...(damage === undefined ? {} : { damage }),
      ...(armourClass === undefined ? {} : { armourClass }),
      ...(experience === undefined ? {} : { experience }),
      ...(wimpyAt === undefined ? {} : { wimpyAt }),
      ...(readProse(record.sprite) === undefined ? {} : { sprite: readProse(record.sprite)! }),
      ...(readSpellList(record.spells) === undefined ? {} : { spells: readSpellList(record.spells)! }),
      ...(typeof record.at === 'string' ? { at: record.at } : {}),
      ...(typeof record.by === 'string' ? { by: record.by } : {}),
    };
    if (mobAuthorsAnything(override)) out.set(vnum, override);
  }
  return out;
}

/**
 * Writes the whole overlay, sorted by vnum so a hand-read diff shows what changed.
 *
 * An entry that authors nothing is **dropped rather than written**, the same rule `authorsAnything`
 * enforces for rooms: an empty record is not an authored mob, it is a record of one having been
 * edited and then emptied, and keeping it would make every "is this authored" check answer yes.
 */
export function saveMobOverrides(overrides: MobOverrides, file = MOBS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const out: Record<string, MobOverride> = {};
  for (const vnum of [...overrides.keys()].sort((a, b) => a - b)) {
    const override = overrides.get(vnum)!;
    if (!mobAuthorsAnything(override)) continue;
    out[String(vnum)] = override;
  }
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

/** What a mob is authored to be wearing and carrying, resolved against the catalogue. */
export interface Outfit {
  readonly worn: readonly { readonly slot: EquipSlot; readonly item: Item }[];
  readonly carried: readonly Item[];
  /** Loot rows naming a vnum the catalogue does not have. Reported rather than swallowed. */
  readonly missing: readonly number[];
}

/**
 * Turns an override into things, against the catalogue.
 *
 * **Instantiated per call**, because every instance gets its own copy: two kobold guards authored to
 * carry a key carry two keys, exactly as two harvested `G` commands would. Sharing one `Item` between
 * bodies would make looting one empty the other.
 *
 * Takes `instantiate` rather than importing it so this file stays free of the item machinery — the
 * same injection `reset.ts` uses, and for the same reason.
 */
export function outfitFor(
  override: MobOverride | undefined,
  items: ReadonlyMap<number, ItemTemplate>,
  instantiate: (template: ItemTemplate) => Item,
): Outfit {
  const worn: { slot: EquipSlot; item: Item }[] = [];
  const carried: Item[] = [];
  const missing: number[] = [];
  for (const row of override?.loot ?? []) {
    const template = items.get(row.vnum);
    if (!template) {
      missing.push(row.vnum);
      continue;
    }
    const item = instantiate(template);
    if (row.slot) worn.push({ slot: row.slot, item });
    else carried.push(item);
  }
  return { worn, carried, missing };
}

/**
 * Puts an outfit on a mob, and says how many pieces went on.
 *
 * **Applied after the reset table has dressed it, so authored loot wins a slot** — and the piece it
 * displaces goes into the mob's hands rather than being destroyed. That is what makes the "additive,
 * never a replacement" claim literally true: the number of things on the body never goes down, so a
 * corpse still holds everything the harvest gave it plus everything somebody authored. It is also the
 * rule `reset.ts` already uses for a wear position we do not model — *"it still exists and is still
 * worth taking off the body, so it goes in the mob's hands"*.
 *
 * The armour refold is the caller's, because the base armour class is theirs to know: a mob's own AC
 * before any kit is not recoverable from the mob once something is on it.
 */
export function applyOutfit(mob: { equipped: Partial<Record<EquipSlot, Item>>; carrying: Item[] }, outfit: Outfit): number {
  for (const item of outfit.carried) mob.carrying.push(item);
  for (const { slot, item } of outfit.worn) {
    const displaced = mob.equipped[slot];
    if (displaced) mob.carrying.push(displaced);
    mob.equipped[slot] = item;
  }
  return outfit.carried.length + outfit.worn.length;
}
