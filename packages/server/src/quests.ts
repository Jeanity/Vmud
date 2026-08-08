/**
 * Quests — Phase 21 slice 7, the phase's fourth word, cut honestly.
 *
 * Duris's quest system is thousands of lines of tokens, bits and specials; this is **one mechanism
 * and one authored quest** (`DESIGN-characters.md` §8): a giver mob, an ask, an objective you can
 * point at, a reward from pools that already exist. The definitions live in
 * `data/world/overrides/quests.json` — hand-authored content in the one directory git tracks for
 * exactly that reason, and a shape the admin panel can grow an editor for (Track A).
 *
 * What a *player* holds is one number per quest id — kills so far — or the string `done`; the
 * definitions carry everything else, so editing a quest's prose or reward touches no save file.
 * The loader takes the same posture as `shops.ts`: a missing file is a world with no quests in it,
 * not a server that will not boot, and a malformed row is skipped loudly rather than half-loaded.
 *
 * ## A7q — the editor's half
 *
 * The Track A editor promised in the paragraph above is built, and it comes in through
 * {@link draftQuest}: **one validator for the form POST and the hand-edited file**, exactly the
 * arrangement `mob-authoring.ts` keeps, so a field cannot be legal through one door and illegal
 * through the other. What that validator deliberately does *not* check is whether the world has the
 * vnums a quest names — it has no world to ask, and it is called at boot before one is loaded. So
 * *shape* is here and *existence* is `admin.ts`'s: a hand-edited giver vnum that matches no mob
 * loads and simply offers work to nobody, which is the loader's own tolerant posture, while the
 * router refuses it with a reason because a form has somebody standing there to tell.
 *
 * **The id is the key and it is a player-facing one.** `PlayerRecord.quests` is keyed by quest id,
 * so an id that changes strands every character's progress on the old string. {@link decodeQuests}
 * drops ids the definitions no longer carry, which makes stranding harmless rather than fatal —
 * but harmless is not the same as intended, which is why the router refuses an id change outright
 * and makes a rename be a delete and a create, two acts an operator chooses on purpose.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { WORLD_DIR } from './world.ts';

export const QUESTS_FILE = join(WORLD_DIR, 'overrides', 'quests.json');

export interface QuestDef {
  readonly id: string;
  /** The mob template that offers it — `quest` spoken in its room is the whole interface. */
  readonly giver: number;
  readonly name: string;
  /** What the giver says when the quest is taken. Spoken, not system-printed. */
  readonly ask: string;
  /** What the giver says at the turn-in. */
  readonly thanks: string;
  readonly objective:
    | { readonly kind: 'kill'; readonly vnum: number; readonly count: number; readonly what: string }
    | { readonly kind: 'bring'; readonly vnum: number; readonly what: string };
  /**
   * What it pays. `item` is an optional third pool beside the two numbers — see the header's
   * *"a reward from pools that already exist"*, of which the catalogue is one.
   */
  readonly reward: { readonly xp: number; readonly copper: number; readonly item?: number };
}

/** Player-side state: kills so far, or finished. The definitions own everything else. */
export type QuestState = number | 'done';

/* -------------------------------------------------------------------------- */
/* A7q — validation, one door                                                  */
/* -------------------------------------------------------------------------- */

/** An id is a slug because it is a **file key and a save-file key**: lower case, no spaces, stable. */
export const QUEST_ID_MAX = 60;
export const QUEST_NAME_MAX = 120;
/** The ask and the thanks are speech. A paragraph is a giver monologuing; 600 is generous already. */
export const QUEST_SPEECH_MAX = 600;
/** *“three kobold youths”* — the phrase the progress line and the ask both interpolate. */
export const QUEST_WHAT_MAX = 120;
/** Fetch-quest-grinding is not a design here: a count over 100 is a typo, not an objective. */
export const QUEST_COUNT_MAX = 100;
/** The same ceilings the mob editor uses for the pools these pay out of. */
export const QUEST_XP_MAX = 10_000_000;
export const QUEST_COPPER_MAX = 10_000_000;

const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

/** The fields a form posts, before validation. Deliberately not `Partial<QuestDef>` — nothing is trusted. */
export interface QuestDraft {
  readonly id?: unknown;
  readonly giver?: unknown;
  readonly name?: unknown;
  readonly ask?: unknown;
  readonly thanks?: unknown;
  readonly objective?: unknown;
  readonly reward?: unknown;
}

/** A required line of prose, trimmed. The reason it is not usable comes back as a sentence. */
function readLine(raw: unknown, field: string, max: number): { text: string } | { error: string } {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { error: `${field} is required` };
  const text = raw.trim();
  if (text.length > max) return { error: `${field} must be at most ${max} characters` };
  return { text };
}

/**
 * A draft turned into a definition, or the reason it cannot be.
 *
 * The *reason* rather than a bare `undefined`, for {@link draftAuthoredMob}'s reason: a person reads
 * this at a form, and "refused" with no cause is the difference between an editor somebody can use
 * and one they file a bug about.
 *
 * **Shape only** — see the file header. Whether the world has mob 1401 or item 1422 is a question
 * this cannot ask and `admin.ts` does.
 */
export function draftQuest(draft: QuestDraft): { quest: QuestDef } | { error: string } {
  const id = typeof draft.id === 'string' ? draft.id.trim().toLowerCase() : '';
  if (!id) return { error: 'id is required' };
  if (id.length > QUEST_ID_MAX) return { error: `id must be at most ${QUEST_ID_MAX} characters` };
  if (!ID_SHAPE.test(id)) {
    return { error: 'id must be a slug: lower-case letters, digits and hyphens, starting with a letter or digit' };
  }

  if (typeof draft.giver !== 'number' || !Number.isInteger(draft.giver) || draft.giver < 0) {
    return { error: 'giver must be a whole mob vnum' };
  }

  const name = readLine(draft.name, 'name', QUEST_NAME_MAX);
  if ('error' in name) return name;
  const ask = readLine(draft.ask, 'ask', QUEST_SPEECH_MAX);
  if ('error' in ask) return ask;
  const thanks = readLine(draft.thanks, 'thanks', QUEST_SPEECH_MAX);
  if ('error' in thanks) return thanks;

  if (typeof draft.objective !== 'object' || draft.objective === null) {
    return { error: 'objective must be {"kind":"kill","vnum":…,"count":…,"what":…} or {"kind":"bring","vnum":…,"what":…}' };
  }
  const raw = draft.objective as Record<string, unknown>;
  if (raw.kind !== 'kill' && raw.kind !== 'bring') return { error: 'objective kind must be "kill" or "bring"' };
  if (typeof raw.vnum !== 'number' || !Number.isInteger(raw.vnum) || raw.vnum < 0) {
    return { error: `objective vnum must be a whole ${raw.kind === 'kill' ? 'mob' : 'item'} vnum` };
  }
  const what = readLine(raw.what, 'objective what', QUEST_WHAT_MAX);
  if ('error' in what) return what;
  let objective: QuestDef['objective'];
  if (raw.kind === 'kill') {
    if (typeof raw.count !== 'number' || !Number.isInteger(raw.count) || raw.count < 1 || raw.count > QUEST_COUNT_MAX) {
      return { error: `objective count must be a whole number from 1 to ${QUEST_COUNT_MAX}` };
    }
    objective = { kind: 'kill', vnum: raw.vnum, count: raw.count, what: what.text };
  } else {
    objective = { kind: 'bring', vnum: raw.vnum, what: what.text };
  }

  if (typeof draft.reward !== 'object' || draft.reward === null) {
    return { error: 'reward must be {"xp":…,"copper":…}' };
  }
  const paid = draft.reward as Record<string, unknown>;
  // Zero is a legal reward on both — a quest can pay only in coin, or only in the thanks — so the
  // floor is 0 rather than 1, and a missing field is 0 rather than a refusal.
  const xp = paid.xp === undefined || paid.xp === null ? 0 : paid.xp;
  const copper = paid.copper === undefined || paid.copper === null ? 0 : paid.copper;
  if (typeof xp !== 'number' || !Number.isInteger(xp) || xp < 0 || xp > QUEST_XP_MAX) {
    return { error: `reward xp must be a whole number from 0 to ${QUEST_XP_MAX}` };
  }
  if (typeof copper !== 'number' || !Number.isInteger(copper) || copper < 0 || copper > QUEST_COPPER_MAX) {
    return { error: `reward copper must be a whole number from 0 to ${QUEST_COPPER_MAX}` };
  }
  // **Absent rather than zero.** Item 0 is a legal vnum, so `0` cannot double as "pays no item" the
  // way `copper: 0` does; the field is either a vnum or it is not there. `null` reads as an editor
  // clearing it, which is the same thing.
  const item = paid.item === undefined || paid.item === null ? undefined : paid.item;
  if (item !== undefined && (typeof item !== 'number' || !Number.isInteger(item) || item < 0)) {
    return { error: 'reward item must be a whole item vnum, or absent' };
  }

  return {
    quest: {
      id,
      giver: draft.giver,
      name: name.text,
      ask: ask.text,
      thanks: thanks.text,
      objective,
      reward: { xp, copper, ...(item === undefined ? {} : { item }) },
    },
  };
}

export function loadQuests(file = QUESTS_FILE): Map<string, QuestDef> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
  const out = new Map<string, QuestDef>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw as unknown[]) {
    // A7q: the API's own validator rather than a second, laxer one — a file somebody edited by hand
    // deserves exactly the checks a form POST gets. The warn stays: a skipped row is a quest that has
    // quietly stopped existing, and silence there is how nobody finds out until a player asks.
    const drafted = draftQuest((entry ?? {}) as QuestDraft);
    if ('error' in drafted) {
      const named = typeof (entry as { id?: unknown } | null)?.id === 'string' ? (entry as { id: string }).id : entry;
      console.warn(`[quests] skipping malformed quest ${JSON.stringify(named).slice(0, 60)}: ${drafted.error}`);
      continue;
    }
    out.set(drafted.quest.id, drafted.quest);
  }
  return out;
}

/**
 * Writes the definitions back, in the loader's exact shape and the **hand-authored layout**.
 *
 * The file is content in the one git-tracked directory: people read it and git diffs it, so the
 * writer's output has to be the thing a person would have typed. Two rules do that.
 *
 * **Key order is rebuilt field by field**, never copied from whatever object arrived — `id, giver,
 * name, ask, thanks, objective, reward` is the reading order (who asks, what they say, what they
 * want, what they pay), and `JSON.stringify` follows insertion order, so stating it here is what
 * fixes it. `count` is written only on a `kill`, because a `bring` carrying one would be a field the
 * loader ignores and a reader believes.
 *
 * **`objective` and `reward` stay on one line each**, which is the only reason this is not a plain
 * `JSON.stringify(rows, null, 2)`: an eight-line quest block reads as a quest, and the pretty
 * printer's exploded four-line objective turns the shipped file into something no longer diffable
 * against what was hand-written in it. Every *value* still goes through `JSON.stringify`, so
 * escaping is the library's and not this function's.
 *
 * Sorted by id, for the reason `saveAuthoredMobs` sorts by vnum: a stable order means a diff shows
 * the change rather than the shuffle.
 */
export function saveQuests(quests: Iterable<QuestDef>, file = QUESTS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const blocks = [...quests]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((quest) => {
      const objective =
        quest.objective.kind === 'kill'
          ? { kind: 'kill', vnum: quest.objective.vnum, count: quest.objective.count, what: quest.objective.what }
          : { kind: 'bring', vnum: quest.objective.vnum, what: quest.objective.what };
      const fields = [
        `    "id": ${JSON.stringify(quest.id)}`,
        `    "giver": ${JSON.stringify(quest.giver)}`,
        `    "name": ${JSON.stringify(quest.name)}`,
        `    "ask": ${JSON.stringify(quest.ask)}`,
        `    "thanks": ${JSON.stringify(quest.thanks)}`,
        `    "objective": ${inline(objective)}`,
        // `item` only when it is paid, for `count`'s reason one paragraph up: a field the loader
        // treats as absent should not be written as something a reader would believe.
        `    "reward": ${inline({ xp: quest.reward.xp, copper: quest.reward.copper, ...(quest.reward.item === undefined ? {} : { item: quest.reward.item }) })}`,
      ];
      return `  {\n${fields.join(',\n')}\n  }`;
    });
  writeFileSync(file, blocks.length === 0 ? '[]\n' : `[\n${blocks.join(',\n')}\n]\n`);
}

/** `{ "kind": "kill", … }` — JSON with a space after each brace and colon, as the file has it. */
function inline(record: Record<string, unknown>): string {
  const pairs = Object.entries(record).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{ ${pairs.join(', ')} }`;
}

/** The quests a giver template offers, in file order. */
export function questsBy(quests: ReadonlyMap<string, QuestDef>, giver: number): QuestDef[] {
  return [...quests.values()].filter((q) => q.giver === giver);
}

/** Storage shape → state map, shrugging at garbage like every decoder beside it. */
export function decodeQuests(stored: unknown): Map<string, QuestState> {
  const out = new Map<string, QuestState>();
  if (typeof stored !== 'object' || stored === null) return out;
  for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
    if (value === 'done') out.set(id, 'done');
    else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out.set(id, value);
  }
  return out;
}
