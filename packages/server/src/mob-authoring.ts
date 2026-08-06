/**
 * Mobs that were **made here** — **A9b**, and `item-authoring.ts`'s twin down to the argument.
 *
 * `mob-overrides.ts` patches the harvest: a handful of changed fields keyed by vnum, folded over a
 * template that already exists. That shape is exactly right for editing a Duris mob and exactly wrong for
 * inventing one, because a patch presupposes something to patch. A creature with no `.mob` record behind
 * it *is* its record, and the two differ in every rule that matters:
 *
 * | | `mob-overrides.ts` | here |
 * | --- | --- | --- |
 * | Shape | a few optional fields | a complete {@link MobTemplate} |
 * | Composed by | folding over a pristine template | being added to the template map |
 * | Empty entry means | *nothing is authored* — delete it, take the ✎ off | nothing; the mob stays |
 * | Re-harvest | flows through wherever it was not authored | cannot touch it at all |
 *
 * Those last two are why this is a separate file rather than a range check inside the other one. An
 * override that authors nothing **must** be deleted or the row wears an editor's mark for ever; a created
 * mob whose name is blanked is a bug, not a request to delete the creature.
 *
 * ## What a created mob still cannot do, and it is worth saying
 *
 * It exists as a template, which means it can be spawned, fought, killed and looted. What it has no way
 * to do yet is **repop**: a zone's population comes from `data/world/spawns/*.json`, which is a build
 * output of `npm run worldgen` and would be overwritten by the next harvest. Placing one permanently
 * therefore needs its own overlay — the reset-table half of A9b — and until that lands a created mob is
 * something an operator puts in the world by hand.
 *
 * ## Validated, never trusted
 *
 * The file is hand-editable by design, like its siblings, so a malformed record is dropped rather than
 * guessed at: a template that reaches the map half-built fails somewhere else entirely — a `NaN` in the
 * hit-point dice is a creature that spawns dead. {@link readAuthoredMob} is the only door in, and it runs
 * the API's own validator rather than a second, laxer one.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTHORED_MOB_BASE,
  attackBonusFor,
  armourToAc,
  huntRule,
  noPursuit,
  parseDice,
  passiveRule,
  reactionFor,
  roundLengthFor,
  type MobTemplate,
} from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where created mobs live — beside the other four overlays, and exported for the same reason. */
export const AUTHORED_MOBS_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'mobs-authored.json');

/** A created mob, plus the provenance every overlay in this project records. */
export interface AuthoredMob {
  readonly mob: MobTemplate;
  /** When it was last written, so the panel can say how stale it is. */
  readonly at?: string;
  /** Who or what wrote it. */
  readonly by?: string;
}

export type AuthoredMobs = Map<number, AuthoredMob>;

/**
 * The overlay as a whole: the records, and the number to hand out next.
 *
 * **The counter is stored rather than derived**, for the reason `AuthoredStore` gives: *"highest existing
 * plus one"* looks like it never repeats until you delete the highest, at which point the next creation
 * gets the number just freed — and a vnum is an identity. A recycled mob number would silently change
 * what a saved corpse, a threat ledger or an instance limit refers to.
 */
export interface AuthoredMobStore {
  readonly mobs: AuthoredMobs;
  /** The next vnum to allocate. Only ever increases, including across a delete. */
  next: number;
}

/**
 * The fields a form supplies, before defaults.
 *
 * Deliberately **not** `Partial<MobTemplate>`. `vnum` is the server's to allocate; `combat` is *derived*
 * from the level and the two columns below it, so a form that posted an attack bonus would be posting a
 * number the next level edit overwrites; and `aggro`/`pursuit` are whole rules reduced here to the two
 * booleans that have something to evaluate — see {@link aggressive}.
 */
export interface MobDraft {
  readonly name?: unknown;
  readonly room?: unknown;
  readonly keywords?: unknown;
  readonly level?: unknown;
  readonly hp?: unknown;
  readonly damage?: unknown;
  readonly armourClass?: unknown;
  readonly experience?: unknown;
  readonly wimpyAt?: unknown;
  readonly sprite?: unknown;
  /**
   * Whether it attacks on sight.
   *
   * **One boolean rather than the six fields of an `AggroRule`**, and that is the same call A9 made when
   * it refused to author aggression at all — with the objection answered rather than dodged. A9's problem
   * was a form that could set `disposition: 'aggressive'` while leaving `clauses` empty, which produces a
   * creature marked hostile that never attacks anybody, because `matchesAggro` reads the clauses. A
   * boolean cannot express that state: true writes `aggressive` **and** the `all` clause together, which
   * is the one clause fully evaluable before races and alignment arrive at Phase 21. The richer clauses
   * become a wider control the day there is a subject to test them against.
   */
  readonly aggressive?: unknown;
  /** Whether it follows you out of the room. `huntRule`'s hunter bit, leashed to its own zone. */
  readonly hunts?: unknown;
}

const MAX_LEVEL = 60;
const MAX_AC = 40;
const MAX_EXPERIENCE = 10_000_000;
const MAX_WIMPY = 100_000;
const NAME_MAX = 120;
const ROOM_MAX = 400;
const KEYWORD_MAX = 30;
const SPRITE_MAX = 80;

/** A whole number in range, or nothing. The shape every numeric field here is checked against. */
function readInt(raw: unknown, low: number, high: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < low || raw > high) return undefined;
  return raw;
}

/**
 * The words a player may type at it, deduplicated and folded to lower case.
 *
 * Deduplicated **because the panel diffs against what the server stored** — A6b's lesson: store what you
 * canonicalise, or an entry equal to its own input looks like a change for ever.
 */
function readKeywords(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const words = [
    ...new Set(
      (raw as unknown[])
        .filter((w): w is string => typeof w === 'string')
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length > 0),
    ),
  ];
  if (words.length === 0) return undefined;
  return words.some((w) => w.length > KEYWORD_MAX) ? undefined : words;
}

/**
 * A draft turned into a complete template, or the reason it cannot be.
 *
 * Returns the *reason* rather than a bare `undefined` because this is a validator whose failure a person
 * reads: it answers a form POST, and "refused" with no cause is the difference between an editor somebody
 * can use and one they file a bug about.
 *
 * **Defaults are applied here and nowhere else**, so a record on disk is always whole. The room line falls
 * back to Duris' own idiom, and `combat` is built by the same arithmetic `readCombatStats` uses — through
 * `armourToAc`'s scale rather than around it, so a created mob and a harvested one are hit by the same
 * roll against the same numbers.
 */
export function draftAuthoredMob(vnum: number, draft: MobDraft): { mob: MobTemplate } | { error: string } {
  if (!Number.isInteger(vnum) || vnum < AUTHORED_MOB_BASE) {
    return { error: `an authored mob vnum must be an integer at or above ${AUTHORED_MOB_BASE}` };
  }

  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (!name) return { error: 'name is required' };
  if (name.length > NAME_MAX) return { error: `name must be at most ${NAME_MAX} characters` };

  const keywords = readKeywords(draft.keywords);
  if (!keywords) {
    return { error: `at least one keyword is required, each at most ${KEYWORD_MAX} characters — it is what a player types` };
  }

  const level = readInt(draft.level, 1, MAX_LEVEL);
  if (level === undefined) return { error: `level must be a whole number from 1 to ${MAX_LEVEL}` };

  const hp = typeof draft.hp === 'string' ? draft.hp.trim() : '';
  if (!parseDice(hp)) return { error: 'hit points must be dice the game can roll, like "8d8+16"' };

  const damage = typeof draft.damage === 'string' ? draft.damage.trim() : '';
  const rolled = parseDice(damage);
  if (!rolled) return { error: 'damage must be dice the game can roll, like "2d6+2"' };

  const armourClass = draft.armourClass === undefined || draft.armourClass === null
    ? armourToAc(0)
    : readInt(draft.armourClass, 0, MAX_AC);
  if (armourClass === undefined) return { error: `armour class must be a whole number from 0 to ${MAX_AC}` };

  const experience = draft.experience === undefined || draft.experience === null
    ? 0
    : readInt(draft.experience, 0, MAX_EXPERIENCE);
  if (experience === undefined) return { error: `experience must be a whole number from 0 to ${MAX_EXPERIENCE}` };

  const wimpyAt = draft.wimpyAt === undefined || draft.wimpyAt === null ? 0 : readInt(draft.wimpyAt, 0, MAX_WIMPY);
  if (wimpyAt === undefined) return { error: `the wimpy threshold must be a whole number from 0 to ${MAX_WIMPY}` };

  const sprite = typeof draft.sprite === 'string' && draft.sprite.trim() ? draft.sprite.trim() : 'human';
  if (sprite.length > SPRITE_MAX) return { error: `sprite must be at most ${SPRITE_MAX} characters` };

  const room = typeof draft.room === 'string' && draft.room.trim() ? draft.room.trim() : `${name} is standing here.`;
  if (room.length > ROOM_MAX) return { error: `the room line must be at most ${ROOM_MAX} characters` };

  const attacks = draft.aggressive === true;
  const hunts = draft.hunts === true;

  return {
    mob: {
      vnum,
      keywords,
      name,
      room,
      level,
      hp,
      sprite,
      aggro: attacks
        ? {
            disposition: 'aggressive',
            // Written together with the disposition and never apart from it — see `MobDraft.aggressive`.
            clauses: ['all'],
            reactionMs: reactionFor(level),
            // A hunter that does not remember you is inert, in the source and here — §4.11's dependency,
            // which `huntRule` refuses to let a caller forget. So memory follows the pursuit.
            remembers: hunts,
            sentinel: false,
            assists: false,
          }
        : { ...passiveRule(level), remembers: hunts },
      pursuit: hunts
        ? huntRule({ hunter: true, remembers: true, sentinel: false, staysInZone: true, noLure: false, opensDoors: false })
        : noPursuit(),
      combat: {
        armourClass,
        damage: rolled,
        // Derived, exactly as `readCombatStats` derives them, so a created mob and a harvested one of the
        // same level swing on the same clock with the same accuracy. `martial` is left false because
        // nothing in the world is martial yet — see `attackBonusFor`.
        attackBonus: attackBonusFor(level),
        roundMs: roundLengthFor(level),
      },
      experience,
      wimpyAt,
    },
  };
}

/**
 * One record off disk, or nothing.
 *
 * Runs the same {@link draftAuthoredMob} the API does rather than a second, laxer reader — a file somebody
 * edited by hand deserves exactly the validation a form POST gets, and two validators for one shape is how
 * a field ends up legal through one door and not the other.
 *
 * The record on disk is a **whole template**, so it is read back through the *draft* shape: the derived
 * `combat` is recomputed rather than trusted, which means a hand-edited level cannot leave a creature
 * hitting on the arithmetic of the level it used to be.
 */
export function readAuthoredMob(vnum: number, raw: unknown): AuthoredMob | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const combat = typeof record.combat === 'object' && record.combat !== null
    ? (record.combat as Record<string, unknown>)
    : {};
  const aggro = typeof record.aggro === 'object' && record.aggro !== null
    ? (record.aggro as Record<string, unknown>)
    : {};
  const pursuit = typeof record.pursuit === 'object' && record.pursuit !== null
    ? (record.pursuit as Record<string, unknown>)
    : {};
  const drafted = draftAuthoredMob(vnum, {
    name: record.name,
    room: record.room,
    keywords: record.keywords,
    level: record.level,
    hp: record.hp,
    damage: typeof record.damage === 'string' ? record.damage : writeCombatDamage(combat.damage),
    armourClass: combat.armourClass,
    experience: record.experience,
    wimpyAt: record.wimpyAt,
    sprite: record.sprite,
    aggressive: aggro.disposition === 'aggressive',
    hunts: typeof pursuit.trackRooms === 'number' && pursuit.trackRooms > 0,
  });
  if ('error' in drafted) return undefined;
  return {
    mob: drafted.mob,
    ...(typeof record.at === 'string' ? { at: record.at } : {}),
    ...(typeof record.by === 'string' ? { by: record.by } : {}),
  };
}

/** A stored `Dice` back into the notation the draft validator speaks. Nothing for anything else. */
function writeCombatDamage(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const dice = raw as Record<string, unknown>;
  if (typeof dice.count !== 'number' || typeof dice.sides !== 'number') return undefined;
  const bonus = typeof dice.bonus === 'number' ? dice.bonus : 0;
  return `${dice.count}d${dice.sides}${bonus === 0 ? '' : bonus > 0 ? `+${bonus}` : `-${Math.abs(bonus)}`}`;
}

/**
 * Reads the overlay, tolerating anything. The same posture as every sibling loader.
 *
 * The stored counter is trusted only so far as it is *ahead* of the records: a hand-edited file whose
 * `next` is behind a mob it contains would hand out a number already in use, so the floor is raised to
 * clear whatever is actually there. Wrong in the safe direction, which is the only direction a number
 * allocator may be wrong in.
 */
export function loadAuthoredMobs(file = AUTHORED_MOBS_FILE): AuthoredMobStore {
  const mobs: AuthoredMobs = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No overlay is the ordinary case — nothing has been created yet.
    return { mobs, next: AUTHORED_MOB_BASE };
  }
  if (typeof raw !== 'object' || raw === null) return { mobs, next: AUTHORED_MOB_BASE };
  const body = raw as Record<string, unknown>;

  const records = typeof body.mobs === 'object' && body.mobs !== null ? (body.mobs as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(records)) {
    const vnum = Number(key);
    if (!Number.isInteger(vnum)) continue;
    const authored = readAuthoredMob(vnum, value);
    if (authored) mobs.set(vnum, authored);
  }

  let next = typeof body.next === 'number' && Number.isInteger(body.next) ? body.next : AUTHORED_MOB_BASE;
  for (const vnum of mobs.keys()) if (vnum >= next) next = vnum + 1;
  return { mobs, next: Math.max(next, AUTHORED_MOB_BASE) };
}

/**
 * Writes the whole overlay: the counter, then the records sorted by vnum.
 *
 * Each record is flat rather than `{ mob: {...}, at }` — the file is meant to be readable and
 * hand-editable, and a second level of nesting per entry buys nothing a reader wants. `vnum` is written
 * into the body as well as being the key, redundant on purpose, so a record copied out on its own still
 * says which creature it is.
 */
export function saveAuthoredMobs(store: AuthoredMobStore, file = AUTHORED_MOBS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const records: Record<string, unknown> = {};
  for (const vnum of [...store.mobs.keys()].sort((a, b) => a - b)) {
    const authored = store.mobs.get(vnum)!;
    records[String(vnum)] = {
      ...authored.mob,
      ...(authored.at ? { at: authored.at } : {}),
      ...(authored.by ? { by: authored.by } : {}),
    };
  }
  writeFileSync(file, `${JSON.stringify({ next: store.next, mobs: records }, null, 2)}\n`);
}
