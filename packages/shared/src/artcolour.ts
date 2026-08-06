/**
 * Choosing a colour from a description — **A7f**.
 *
 * Owner's ask, 2026-08-05: *"it would be great if we can have ollama do the edits based on the
 * description. if that is even possible."* It is, and the roadmap was precise about what it is: a model
 * **cannot draw pixels**; it maps a description onto one of a closed list of ramp names. A7e made that
 * list real — 215 ramps across 12 tables — so this is classification over a fixed vocabulary, which is
 * the one thing a small local model is reliably good at.
 *
 * ## The model is the fallback, not the first resort
 *
 * This is the design decision, and it came out of A7g. A builder's own name for a thing very often
 * *contains the answer*: **"a hooded black cape"** wants `black`, **"&+La long thin flaming rapier"**
 * wants something fiery. So the vocabulary is matched against the name directly first, and Ollama is
 * asked only when that finds nothing.
 *
 * Three things follow, and each is worth more than the cleverness it replaces:
 *
 * 1. **It works with Ollama switched off**, which is most of the time on most machines.
 * 2. **It is deterministic and testable**, so the common case has a unit test rather than a vibe.
 * 3. **It is faster than a round trip** by three orders of magnitude, which matters enormously for the
 *    bulk pass the roadmap wants — *"a pass could propose art and ramp for a whole zone's loot"*. A
 *    hundred items is a hundred model calls or one loop, and the loop gets most of them right.
 *
 * Note the inversion against `artmatch.ts`, which is deliberate and which a reader should not trip on:
 * A7g put colour words in its **noise list**, because the art pack's own ids carry colours
 * (`belt-belly-brown`) that say nothing about the item. Here the colour word *is* the entire signal.
 * Same corpus, opposite question.
 *
 * ## Where this lives, and why it moved
 *
 * It began in `server/src/` beside the admin route that calls it, and moved to `shared` when the bulk
 * pass arrived: `worldgen` needs the same matcher to propose colours for a whole zone at once, and a
 * worldgen script importing from the server would be a dependency the monorepo does not have and should
 * not grow. Everything here is pure string logic over a closed vocabulary — no I/O, no Node API — which
 * is exactly what `CLAUDE.md` says `shared` is for. The Ollama call stays on the server, where it belongs.
 *
 * ## The model drafts and the human commits
 *
 * `DESIGN-admin-panel.md` §8's rule, which `ollama.ts` already keeps for room prose: this returns a
 * suggestion and writes nothing. It lands in the picker's dropdown where it can be looked at, changed or
 * ignored, and only the ordinary `PATCH /items/:vnum` commits it. A model that auto-saved would put
 * unreviewed colour on the world and, worse, make *not* keeping it the expensive path.
 */

import { splitRamp } from './recolour.ts';

/** Where a suggestion came from. Reported, because *the name said so* deserves more trust than a guess. */
export type ColourSource = 'name' | 'model';

export interface ColourSuggestion {
  /** The chosen ramp, as `table.name` — exactly the string `art` wants after its `#`. */
  readonly ramp: string;
  readonly how: ColourSource;
  /** The word that decided it, for a `name` match. The audit trail, as A7g's `matched` is. */
  readonly because?: string;
  readonly model?: string;
}

/**
 * Words a builder uses for a colour that the pack spells differently.
 *
 * Kept small and only where the mapping is unarguable. The temptation is to grow this into a thesaurus,
 * and the reason not to is that a wrong synonym is *worse* than no match: no match falls through to the
 * model, which can read the whole name, while a wrong synonym confidently ends the search. So: obvious
 * spelling variants and the handful of words the world file uses constantly.
 */
const SYNONYMS: Readonly<Record<string, string>> = {
  grey: 'gray',
  crimson: 'red',
  scarlet: 'red',
  ruby: 'red',
  bloody: 'red',
  flaming: 'red',
  fiery: 'red',
  azure: 'blue',
  sapphire: 'blue',
  emerald: 'green',
  jade: 'green',
  golden: 'gold',
  ivory: 'white',
  snowy: 'white',
  ebony: 'black',
  obsidian: 'black',
  sable: 'black',
  bronzed: 'bronze',
  rusted: 'copper',
  rusty: 'copper',
  wooden: 'oak',
  leathern: 'leather',
};

/**
 * A word set with the synonyms folded in **as extras rather than replacements**, so *"a golden helm"*
 * matches `gold` while *"a golden brown cloak"* can still reach `brown` if that is what the list has.
 */
function expand(words: readonly string[]): Set<string> {
  const out = new Set(words);
  for (const word of words) {
    const synonym = SYNONYMS[word];
    if (synonym) out.add(synonym);
  }
  return out;
}

/** The words a name offers, colour codes stripped. Unlike A7g's reader, **nothing is filtered out**. */
export function colourWords(text: string): string[] {
  return text
    .replace(/&[+-]?.?/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}

/**
 * The ramp a name asks for outright, or nothing.
 *
 * **Ordered by the candidate list, not by the name.** Two colour words in one name — *"a black and gold
 * tabard"* — must resolve the same way every run, and the ramp list is the stable order; scanning the
 * name instead would make the answer depend on how the builder phrased it.
 *
 * A ramp is matched on its **name half only**: `cloth_ulpc.red` answers to *red*, never to *cloth*, and
 * certainly never to *ulpc*. Matching the table would pair every leather item with `cloth_ulpc.leather`
 * for the wrong reason and every item at all with whichever table sorted first.
 */
export function rampFromName(
  name: string,
  keywords: readonly string[],
  ramps: readonly string[],
): { readonly ramp: string; readonly because: string } | undefined {
  // **The display name is tried before the keywords, and a bulk run is what proved it necessary.**
  // *"a silver-threaded satchel"* carries the keywords `[satchel, silver, threaded, leather]`, and with
  // one pooled bag of words the ramp list's own order decided it — `cloth_ulpc.leather` sits early, so a
  // satchel the builder called *silver* came out brown. The name is that builder's description of *this*
  // item; keywords are search terms and routinely carry a material or a class word that describes what
  // the thing is made of rather than what colour it is. So the name gets first refusal and the keywords
  // are the fallback, which is what makes *"a large tar dipped torch"* still reach `oak` through its
  // `wooden` keyword when its name offers nothing.
  const fromName = expand(colourWords(name));
  const fromEverything = expand([...colourWords(name), ...keywords.flatMap((k) => colourWords(k))]);

  for (const wanted of [fromName, fromEverything]) {
    // **Compound names first within each pass**, and the order is the whole subtlety. `blue_violet` and
    // `red_orange` are real ramps. Trying plain names first would give *"a blue violet robe"* plain
    // `blue`, because *blue* matches and the search stops — so the more specific reading never gets a
    // turn. Running compounds first cannot cost the plain case anything, since a compound needs **both**
    // its halves present and *"a blue cloak"* has only one.
    for (const ramp of ramps) {
      const parts = splitRamp(ramp);
      if (!parts || !parts.name.includes('_')) continue;
      if (parts.name.split('_').every((half) => wanted.has(half))) {
        return { ramp, because: parts.name.replace('_', ' ') };
      }
    }
    for (const ramp of ramps) {
      const parts = splitRamp(ramp);
      if (parts && wanted.has(parts.name)) return { ramp, because: parts.name };
    }
  }
  return undefined;
}

/**
 * What the model is asked. **The whole vocabulary, and nothing else to say.**
 *
 * Two rules the room-prose prompt taught, applied here. The candidate list is given **in full** rather
 * than described, because a model asked for "a colour" invents *cerulean-adjacent* and a model handed 24
 * words picks one of them. And the answer format is stated as the entire response — models given room to
 * be conversational will use it, and *"Sure! I'd say **red** works well here."* is a parsing problem
 * nobody needs to have.
 *
 * The names are offered without their table, because the table is bookkeeping the model cannot reason
 * about and would only be another token to get wrong. {@link readRampAnswer} puts it back.
 */
export function buildColourPrompt(item: { name: string; keywords: readonly string[] }, ramps: readonly string[]): string {
  const names = [...new Set(ramps.map((r) => splitRamp(r)?.name).filter((n): n is string => Boolean(n)))];
  return [
    'You are choosing the colour of an item in a fantasy game from a fixed list.',
    '',
    `Item name: ${item.name.replace(/&[+-]?.?/g, '')}`,
    item.keywords.length > 0 ? `Keywords: ${item.keywords.join(', ')}` : '',
    '',
    'Choose the single closest colour from this list:',
    names.join(', '),
    '',
    'Reply with exactly one word from the list and nothing else. No punctuation, no explanation.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * The model's answer turned back into a ramp, or nothing.
 *
 * **Validated against the closed list rather than trusted**, which is the whole reason this is
 * classification and not generation: a model that answers *crimson* to a list containing *red* has
 * failed, and the honest response is to fall through rather than to invent `cloth_ulpc.crimson` and let
 * it be refused three layers away by `isKnownArt`.
 *
 * Forgiving about the wrapper and strict about the word: an answer is scanned for **any** listed name,
 * because *"red"*, *"Red."* and *"I would choose red"* all mean red and all three happen. The first
 * *listed* ramp wins rather than the first word of the answer, so a preamble cannot beat the choice.
 */
export function readRampAnswer(answer: string, ramps: readonly string[]): string | undefined {
  const said = new Set(colourWords(answer));
  for (const word of said) {
    const synonym = SYNONYMS[word];
    if (synonym) said.add(synonym);
  }
  // Compounds first, for the reason `rampFromName` gives.
  for (const ramp of ramps) {
    const parts = splitRamp(ramp);
    if (parts?.name.includes('_') && parts.name.split('_').every((half) => said.has(half))) return ramp;
  }
  for (const ramp of ramps) {
    const parts = splitRamp(ramp);
    if (parts && said.has(parts.name)) return ramp;
  }
  return undefined;
}

/**
 * A colour for one item — the name first, the model only if the name says nothing.
 *
 * `ask` is injected rather than imported so the ordering can be tested without a model running, which is
 * the same reason `outfitFor` takes `instantiate`: the interesting behaviour here is *when the model is
 * consulted*, and that is exactly what a live model would make impossible to assert.
 */
export async function suggestColour(
  item: { readonly name: string; readonly keywords: readonly string[] },
  ramps: readonly string[],
  ask?: (prompt: string) => Promise<string | undefined>,
): Promise<ColourSuggestion | undefined> {
  const fromName = rampFromName(item.name, item.keywords, ramps);
  if (fromName) return { ramp: fromName.ramp, how: 'name', because: fromName.because };
  if (!ask) return undefined;
  const answer = await ask(buildColourPrompt(item, ramps));
  if (!answer) return undefined;
  const ramp = readRampAnswer(answer, ramps);
  return ramp ? { ramp, how: 'model' } : undefined;
}
