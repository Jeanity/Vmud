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
 *
 * **A counted `bring` stores nothing, and that is the design.** Its progress is read off the bag at
 * the moment somebody asks — {@link carriedForQuest} — rather than accumulated into that number, so
 * the save format did not change when counting arrived and {@link decodeQuests} needed no new case.
 * Storing it would be a second copy of a fact the inventory already holds, and the two would part
 * company the first time a player dropped a nugget: a stored `5/8` over an empty bag is a quest that
 * completes on air.
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

import { vnumOf, type Inventory, type Stack } from '@mygame/shared';

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
  /**
   * **Both shapes count.** `bring` gained a `count` for the reason `REFERENCE-duris-quests.md` §4
   * gives: of the 3,275 harvested exchanges, **1,154 want several of an item** — Szxvu's eight silver
   * nuggets, the priest's three pages — and a fetch objective that could only ever mean *one* could
   * express none of them. It is normalised rather than optional here: a draft may omit it and mean
   * one, but a definition always carries the number, so nothing downstream has to remember a default.
   * That is what lets `objective.count` be read straight off the union without narrowing first.
   */
  readonly objective:
    | { readonly kind: 'kill'; readonly vnum: number; readonly count: number; readonly what: string }
    | { readonly kind: 'bring'; readonly vnum: number; readonly count: number; readonly what: string };
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
  // **`kill` requires the number; `bring` defaults it to one.** The asymmetry is back-compatibility
  // and nothing else: every `bring` quest authored before counting existed omits the field and means
  // one of the thing, and those rows are shipped content in a git-tracked file. `null` reads as absent
  // for the same reason it does on `reward.item` — a form that cleared the box.
  const countable = raw.count === undefined || raw.count === null ? (raw.kind === 'bring' ? 1 : undefined) : raw.count;
  if (
    typeof countable !== 'number' ||
    !Number.isInteger(countable) ||
    countable < 1 ||
    countable > QUEST_COUNT_MAX
  ) {
    return { error: `objective count must be a whole number from 1 to ${QUEST_COUNT_MAX}` };
  }
  const objective: QuestDef['objective'] =
    raw.kind === 'kill'
      ? { kind: 'kill', vnum: raw.vnum, count: countable, what: what.text }
      : { kind: 'bring', vnum: raw.vnum, count: countable, what: what.text };

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
 * fixes it.
 *
 * **A `bring` writes `count` only when it is more than one.** It used to write none at all, because
 * the loader ignored the field; now the loader honours it and the rule becomes the same one
 * `reward.item` keeps — say what is true, and stay silent about the default. That silence is load
 * bearing: the four quests shipped in this file were hand-authored before counting existed, and a
 * writer that added `"count": 1` to each of them would turn the first panel edit of any quest into a
 * diff touching every other. A `kill` still always writes it, because a `kill` has always required it.
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
        quest.objective.kind === 'kill' || quest.objective.count > 1
          ? { kind: quest.objective.kind, vnum: quest.objective.vnum, count: quest.objective.count, what: quest.objective.what }
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

/* -------------------------------------------------------------------------- */
/* The `bring` arithmetic — here rather than in `index.ts`, so it can be tested */
/* -------------------------------------------------------------------------- */

/**
 * How many of an item vnum a bag holds, counting **stacks by their depth**.
 *
 * The two things this gets right are the two the one-item version never had to.
 *
 * **It matches on `vnumOf`, not on a word.** The bug commit `41aecce` fixed: an instance's id is
 * `obj:<vnum>` and its keyword list is the catalogue's words unioned with its display name, so asking
 * `matchInventory` for the bare digits matched nothing and every `bring` quest was silently
 * uncompletable. `vnumOf` is the join the death spoils and the keyword resolver already use.
 *
 * **A stack of eight nuggets is eight nuggets.** Summing `stack.count` rather than counting stacks is
 * the whole difference for a counted objective, because the thing Szxvu wants eight of is exactly the
 * kind of small identical object the bag merges into one slot. Counting slots would report `1` for a
 * full stack and make an eight-nugget quest permanently unfinishable.
 *
 * **Top-level only, deliberately.** A thing inside a closed pack is not in your hands; the one-item
 * check never looked in containers either, and widening that here would change what every existing
 * quest accepts under cover of a counting change.
 */
export function carriedForQuest(inventory: Inventory, vnum: number): number {
  return inventory.stacks.reduce((total, stack) => (vnumOf(stack.item) === vnum ? total + stack.count : total), 0);
}

/**
 * Takes exactly `count` of a vnum out of the bag — the turn-in's own half of the exchange.
 *
 * **Duris eats the object, and we did not.** `quest_completion` does `obj_from_char` + `extract_obj`
 * (`quest.c:145-160`); ours only ever checked that you *held* the thing, so the Viscount ate an onion
 * you walked away still carrying and a single item could turn in every fetch quest in the world.
 * `REFERENCE-duris-quests.md` §4 lists that as the one gap to fold into this work, and the turn-in's
 * own comment in `index.ts` already claimed the giver *"has taken the brought thing"* — so this is
 * the code catching up with what the prose beside it always said.
 *
 * **Exactly `count`, never the stack.** Bring eight of ten nuggets and two stay yours. Stacks are
 * drained in the order they sit in, and one emptied is dropped rather than kept at zero — the rule
 * `removeAt` states for the same reason: a bag must never hold a stack of nothing.
 *
 * Callers check {@link carriedForQuest} first. Handed more than the bag holds this takes what there
 * is, because a consume that silently *refused* would close a quest and leave the goods behind.
 */
export function consumeBrought(inventory: Inventory, vnum: number, count: number): Inventory {
  let left = Math.max(0, count);
  const stacks: Stack[] = [];
  for (const stack of inventory.stacks) {
    if (left === 0 || vnumOf(stack.item) !== vnum) {
      stacks.push(stack);
      continue;
    }
    const taken = Math.min(left, stack.count);
    left -= taken;
    if (taken < stack.count) stacks.push({ ...stack, count: stack.count - taken });
  }
  return { stacks, capacity: inventory.capacity };
}

/**
 * The objective as a phrase — *"8 small nuggets of silver"*, but *"an onion"* rather than *"1 an onion"*.
 *
 * The `what` of a quest authored before counting existed is written for a sentence with no number in
 * front of it, article and all, because there was never a number to put there. Prefixing `1` to those
 * reads as a typo — and they are exactly the quests whose wording must not change, so the count is
 * spoken only when it is worth speaking. A `kill` of one gets the same courtesy for free.
 */
export function objectivePhrase(objective: QuestDef['objective']): string {
  return objective.count === 1 ? objective.what : `${objective.count} ${objective.what}`;
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
