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
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  readonly reward: { readonly xp: number; readonly copper: number };
}

/** Player-side state: kills so far, or finished. The definitions own everything else. */
export type QuestState = number | 'done';

export function loadQuests(file = QUESTS_FILE): Map<string, QuestDef> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
  const out = new Map<string, QuestDef>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw as QuestDef[]) {
    if (
      typeof entry?.id !== 'string' ||
      typeof entry.giver !== 'number' ||
      typeof entry.ask !== 'string' ||
      !entry.objective ||
      (entry.objective.kind !== 'kill' && entry.objective.kind !== 'bring') ||
      typeof entry.reward?.xp !== 'number'
    ) {
      console.warn(`[quests] skipping malformed quest ${JSON.stringify(entry?.id ?? entry).slice(0, 60)}`);
      continue;
    }
    out.set(entry.id, entry);
  }
  return out;
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
