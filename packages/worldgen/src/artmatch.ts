/**
 * Guessing a picture for every item that has none — **A7g**.
 *
 * Owner's ask, 2026-08-06: *"go through all the items that don't have an LPC image associated with it and
 * assign a best guess image to the item. I can go and manually review them later if some items get a weird
 * image."* That last sentence is the specification: this is allowed to be wrong, and being wrong in a way
 * somebody can see and fix beats 16,421 items with no picture at all.
 *
 * ## It writes the overlay, not the catalogue
 *
 * `data/world/items.json` is a build output of `npm run worldgen` and would be erased by the next harvest,
 * which is the rule every authoring path here obeys. So a guess lands in
 * `data/world/overrides/items.json` — the same file A6's editor writes — which means three things fall
 * out for free: the whole run is **one git diff** to throw away, a re-harvest flows through underneath
 * every item this did not touch, and **Restore harvested** in the panel un-guesses one item at a time.
 *
 * ## The slot is the join, and it is the reason this can work at all
 *
 * `artgen` records a `slot` on every art entry, so a hat's picture can only ever be offered to something
 * worn on the head. That single constraint removes almost all of the ways a naive matcher embarrasses
 * itself — the worst case inside a slot is *the wrong hat*, which is a fair way to be wrong, rather than
 * *a hat where a sword should be*.
 *
 * ## Where it deliberately gives up
 *
 * **A slotless item gets nothing.** Every one of the 346 art entries is a piece of equipment; there is no
 * picture of a potion, a key or a loaf in the pack. Guessing inside a slot is a fair bet, but handing a
 * brass key the picture of a bracer is not a guess, it is noise — and it would put a wrong icon in the bag
 * list, where A7d-bag deliberately leaves the cell empty instead. The same goes for the three slots the
 * pack does not cover at all (`face`, `eyes`, `ioun`): a slot with no candidates has no best guess.
 *
 * That is the one place this does less than *"assign a best guess to every item"* asks, and it is reported
 * rather than silent: the run prints what it left alone and why.
 */

import type { ItemTemplate } from '@mygame/shared';

/** The subset of an art entry this needs. Kept structural so the matcher can be tested without the index. */
export interface ArtCandidate {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly slot?: string;
}

/** One guess, with everything a reviewer needs to judge it without opening the game. */
export interface ArtGuess {
  readonly vnum: number;
  readonly art: string;
  /** How the match was made. Sorted on, so the shakiest guesses can be reviewed first. */
  readonly score: number;
  /** Which words did it — the audit trail, and the thing that makes a bad guess diagnosable. */
  readonly matched: readonly string[];
}

/**
 * Words that say nothing about what a thing looks like.
 *
 * Harvested keyword lists are full of them — every third item answers to `the`, and colours are worse
 * than useless here because the art pack's own ids carry colours (`belt-belly-brown`) that have nothing
 * to do with the item's: matching *brown* on both sides would confidently pair a brown cloak with a brown
 * belt. Materials stay in, because `steel`, `leather` and `chain` genuinely describe a picture.
 */
const NOISE = new Set([
  'a', 'an', 'the', 'of', 'and', 'some', 'pair', 'set', 'piece',
  'black', 'white', 'grey', 'gray', 'red', 'blue', 'green', 'yellow', 'brown', 'gold', 'golden',
  'silver', 'purple', 'orange', 'pink', 'dark', 'light', 'pale', 'bright',
  'small', 'large', 'big', 'tiny', 'huge', 'great', 'greater', 'lesser', 'old', 'new', 'fine',
]);

/** Colour codes out, punctuation to spaces, everything lowered. The one place a name becomes words. */
export function words(text: string): string[] {
  return text
    .replace(/&[+-]?.?/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !NOISE.has(word));
}

/**
 * The words an art entry answers to — its id, its kind and its display name.
 *
 * The id is where the signal is (`weapon-sword-longsword-longsword` yields *weapon*, *sword*,
 * *longsword*), which is also why a hyphenated id is worth more than the name: the pack's names are
 * short and generic (*"Armour"*, *"Bracers"*) while the ids are specific.
 */
export function artWords(art: ArtCandidate): Set<string> {
  return new Set([...words(art.id), ...words(art.kind.replace(/_/g, ' ')), ...words(art.name)]);
}

/**
 * How well one art entry fits one item.
 *
 * **Keyword hits are worth three times a name hit**, and that ordering is the whole quality of the
 * matcher. A Diku keyword list is the builder's own answer to *what is this thing* — `["sword",
 * "shortsword", "bronze"]` — while the display name is prose written to read well in a sentence and is
 * full of words that describe the owner rather than the object. Weighting them equally lets *"a longsword
 * of the fallen guard"* match a guard's tabard.
 *
 * Zero means no shared word at all, and the caller treats that as *no opinion* rather than as a bad
 * guess — which is what the per-slot fallback is for.
 */
export function scoreArt(item: Pick<ItemTemplate, 'keywords' | 'name'>, art: ArtCandidate): {
  score: number;
  matched: string[];
} {
  const vocabulary = artWords(art);
  const matched: string[] = [];
  let score = 0;
  for (const keyword of item.keywords) {
    for (const word of words(keyword)) {
      if (!vocabulary.has(word)) continue;
      score += 3;
      matched.push(word);
    }
  }
  for (const word of new Set(words(item.name))) {
    if (!vocabulary.has(word) || matched.includes(word)) continue;
    score += 1;
    matched.push(word);
  }
  return { score, matched };
}

/**
 * The picture to fall back on when nothing in the slot shares a word.
 *
 * **The commonest *kind* in the slot first, then the plainest entry inside it.** The second half alone
 * was the first version and it was wrong in a way the dry run made obvious: shortest-id picks
 * `tool-axe` for `mainHand`, so every unmatched sword in the world became a **farming tool**; it picks
 * `dress-bodice-black` for `chest`, so every plate cuirass became a bodice; and `neck-bowtie-base` for
 * `neck`, so every amulet became a bow tie.
 *
 * Kind-first fixes all three, and it is a rule rather than a patch: how many sheets the pack ships of a
 * kind is a fair proxy for *what this slot is mostly for*. `mainHand` is 26 weapons and 6 tools, so the
 * default is a weapon; `waist` is 8 belts and 2 buckle sets, so it is a belt.
 *
 * Then the fewest words in the id, because a short id in this pack means an unqualified thing — and an
 * unqualified picture is the **right kind of wrong**: a reviewer seeing a plain cape on an item they know
 * is embroidered has learnt something, where a *tattered* cape leaves them unable to tell a guess from a
 * reading of the name. Ties break on the id so a run is reproducible: a matcher whose output moved
 * between runs would make the diff useless for review, which is the whole point of writing one.
 */
export function fallbackFor(candidates: readonly ArtCandidate[]): ArtCandidate | undefined {
  const perKind = new Map<string, number>();
  for (const art of candidates) perKind.set(art.kind, (perKind.get(art.kind) ?? 0) + 1);

  let best: ArtCandidate | undefined;
  for (const art of candidates) {
    if (!best) {
      best = art;
      continue;
    }
    const byKind = (perKind.get(art.kind) ?? 0) - (perKind.get(best.kind) ?? 0);
    if (byKind !== 0) {
      if (byKind > 0) best = art;
      continue;
    }
    // **An id in the kind's own family beats one that merely shares its kind**, and this is what stops a
    // farming tool being every sword's picture. The pack files its tools under the same `weapon` kind as
    // its swords, so kind alone leaves the tie to id length — and `tool-axe` is two words where
    // `weapon-sword-longsword-longsword` is four. The pack names the archetypal family after the kind, so
    // `weapon-*` is what `weapon` means and `tool-*` is the exception filed beside it. Every other slot
    // already agrees with itself here (`cape-*`/cape, `belt-*`/belt), so this changes one slot and
    // disturbs none.
    const byFamily = Number(inKindFamily(art)) - Number(inKindFamily(best));
    if (byFamily !== 0) {
      if (byFamily > 0) best = art;
      continue;
    }
    const here = art.id.split('-').length;
    const there = best.id.split('-').length;
    if (here < there || (here === there && art.id < best.id)) best = art;
  }
  return best;
}

/** Whether an art id sits in the family its own kind is named after — `weapon-*` for kind `weapon`. */
function inKindFamily(art: ArtCandidate): boolean {
  return art.id.split('-')[0] === art.kind.split('_')[0];
}

/** Why an item was left without a picture. Counted and reported rather than silently skipped. */
export type SkipReason = 'already-authored' | 'no-slot' | 'no-art-for-slot';

export interface MatchReport {
  readonly guesses: readonly ArtGuess[];
  readonly skipped: Readonly<Record<SkipReason, number>>;
  /** Slots that had items but no art at all, so a reader can see what the pack is missing. */
  readonly uncoveredSlots: readonly string[];
}

/**
 * A picture for every item that can take one.
 *
 * `alreadyAuthored` is the set of vnums an operator has already given art to by hand: those are **never**
 * touched, because a guess overwriting somebody's deliberate choice is the one failure this tool must not
 * have. That is also why the run is safe to repeat — a second pass re-guesses only what is still unguessed.
 */
export function matchArt(
  items: readonly ItemTemplate[],
  art: readonly ArtCandidate[],
  alreadyAuthored: ReadonlySet<number>,
): MatchReport {
  const bySlot = new Map<string, ArtCandidate[]>();
  for (const entry of art) {
    if (!entry.slot) continue;
    const list = bySlot.get(entry.slot) ?? [];
    list.push(entry);
    bySlot.set(entry.slot, list);
  }

  const guesses: ArtGuess[] = [];
  const skipped: Record<SkipReason, number> = { 'already-authored': 0, 'no-slot': 0, 'no-art-for-slot': 0 };
  const uncovered = new Set<string>();

  for (const item of items) {
    if (alreadyAuthored.has(item.vnum)) {
      skipped['already-authored']++;
      continue;
    }
    if (!item.slot) {
      skipped['no-slot']++;
      continue;
    }
    const candidates = bySlot.get(item.slot);
    if (!candidates || candidates.length === 0) {
      skipped['no-art-for-slot']++;
      uncovered.add(item.slot);
      continue;
    }

    let best: { art: ArtCandidate; score: number; matched: string[] } | undefined;
    for (const candidate of candidates) {
      const { score, matched } = scoreArt(item, candidate);
      if (score === 0) continue;
      // Ties break on the id, for the reproducibility reason `fallbackFor` gives.
      if (!best || score > best.score || (score === best.score && candidate.id < best.art.id)) {
        best = { art: candidate, score, matched };
      }
    }
    if (best) {
      guesses.push({ vnum: item.vnum, art: best.art.id, score: best.score, matched: best.matched });
      continue;
    }
    const fallback = fallbackFor(candidates);
    if (fallback) guesses.push({ vnum: item.vnum, art: fallback.id, score: 0, matched: [] });
  }

  return { guesses, skipped, uncoveredSlots: [...uncovered].sort() };
}
