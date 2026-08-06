/**
 * Re-choosing the pictures A7g could only fall back on — the **A7g quality sweep**.
 *
 * A7g gave 13,248 items a picture: 5,171 on a shared word and **8,077 on a per-slot fallback** — the
 * commonest kind of thing in the slot, chosen because the item's own words matched nothing. A7h then
 * showed what that costs: *"silver-plated leg plates"* word-matched `legs-armour` while *"arm plates"*
 * fell back to a long-sleeved **shirt**, because the matcher matches words exactly and `arm` is not
 * `arms`, `plates` is not `armour`. The fallback is the right kind of wrong — a plausible thing in the
 * right slot — but 8,077 of them deserve a second opinion before anybody trusts the set.
 *
 * The roadmap already names the tool (its generator row, part ①): **Ollama for choosing, not
 * drawing.** Each fallback is a text→classification question — *this item, these candidate sheets,
 * which one?* — which is the one thing a small local model is reliably good at, and exactly what the
 * exact-word matcher is not: a model knows `plates` is armour and a `helm` is a helmet.
 *
 * ## What is sweepable, and the rule that keeps hands off people's work
 *
 * A guess may be re-guessed; a **choice must never be overwritten** — A7g's own contract. But the
 * panel's Save does not stamp `by`, so provenance alone cannot prove a record is still the machine's.
 * What can: the fallback is **deterministic**, so a record is sweepable only when the art it wears is
 * *exactly what the fallback rule computes today* — anybody who changed the sheet took the record out
 * of the set by changing it. Belt and braces, `by` must still read `artassign` or `colourassign`
 * (A7h overwrote the marker on the 361 items it coloured), and `artsweep` marks a record as already
 * done, which is what makes an interrupted run resumable. An item whose art an operator *cleared*
 * ("Restore harvested") has no stored art and is left exactly as un-guessed as they left it.
 *
 * ## The colour survives the sheet change where it can
 *
 * A7h's colour rides the art string (`id#table.name`), and ramps are per-family — a steel that fits a
 * cloth sheet does not necessarily exist on a metal one, and `isKnownArt` would refuse the compound
 * three layers away, which silently costs the item its picture entirely. So a changed sheet keeps its
 * old ramp only when the new sheet's own `recolours` lists it, re-derives one from the name with
 * A7h's own `rampFromName` when it does not, and otherwise drops the colour and says so. A sheet
 * change never *adds* colour to an item that had none — that stays `colourassign`'s job.
 *
 * Pure logic only, `artmatch.ts`'s own split: the prompt and the answer-reader are the parts hardest
 * to get right and easiest to test, so nothing in this file does I/O. The Ollama call lives in the
 * CLI (`artsweep.ts`), injected here the way `suggestColour` takes `ask`.
 */

import { rampFromName, type ItemTemplate } from '@mygame/shared';

import { matchArt, type ArtCandidate } from './artmatch.ts';

/** Provenance markers that mean *a machine wrote this and a machine may rewrite it*. */
const MACHINE_BY: ReadonlySet<string> = new Set(['artassign', 'colourassign']);

/** The marker a swept record carries — and the reason a re-run skips it. */
export const SWEPT_BY = 'artsweep';

/** One fallback guess the model should re-decide, with everything the prompt needs. */
export interface SweepTarget {
  readonly vnum: number;
  /** Effective name — the overlay's when an operator renamed it, the harvest's otherwise. */
  readonly name: string;
  readonly keywords: readonly string[];
  readonly slot: string;
  /** The full stored art, ramp and all — `torso-clothes-longsleeves#cloth_ulpc.steel`. */
  readonly currentArt: string;
  /** Its id half, which equals the recomputed fallback — that equality is what made it sweepable. */
  readonly fallbackId: string;
}

export interface SweepSet {
  readonly targets: readonly SweepTarget[];
  /** Records already marked {@link SWEPT_BY} — a resumed run reports rather than re-asks them. */
  readonly alreadySwept: number;
  /** Score-0 records left alone because art or provenance says a person may have chosen them. */
  readonly guarded: number;
  /** For context in the report: how many recomputed guesses matched on a word (not sweepable). */
  readonly wordMatched: number;
}

/** An overlay as `artassign` reads it: vnum key, unknown fields, hand-editable by design. */
export type Overlay = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The id half of an art string — `cape-solid#cloth_ulpc.red` → `cape-solid`. Local so this file stays pure of I/O deps. */
function idHalf(art: string): string {
  const at = art.indexOf('#');
  return at < 0 ? art : art.slice(0, at);
}

/**
 * The records the model should re-decide.
 *
 * Recomputes A7g's matching over the **effective** catalogue — an operator's renamed item is classified
 * under the name players actually see — and keeps a guess only when all three legs hold: the recomputed
 * match found no shared word (score 0), the stored art still *is* the deterministic fallback, and the
 * provenance marker is a machine's. Everything else is someone's work and stays theirs.
 */
export function sweepSet(items: readonly ItemTemplate[], art: readonly ArtCandidate[], overlay: Overlay): SweepSet {
  const effective = items.map((item) => {
    const record = overlay[String(item.vnum)];
    if (!record) return item;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name : item.name;
    const keywords = Array.isArray(record.keywords)
      ? (record.keywords as unknown[]).filter((w): w is string => typeof w === 'string')
      : item.keywords;
    return name === item.name && keywords === item.keywords ? item : { ...item, name, keywords };
  });

  // An empty authored set on purpose: this wants a guess recomputed for *every* slotted item, because
  // the comparison against the stored art is what decides whose it is — not the skip list.
  const report = matchArt(effective, art, new Set());
  const byVnum = new Map(effective.map((item) => [item.vnum, item]));

  const targets: SweepTarget[] = [];
  let alreadySwept = 0;
  let guarded = 0;
  let wordMatched = 0;

  for (const guess of report.guesses) {
    if (guess.score > 0) {
      wordMatched++;
      continue;
    }
    const record = overlay[String(guess.vnum)];
    const stored = record && typeof record.art === 'string' ? record.art : undefined;
    // No stored art (never guessed, or un-guessed with Restore harvested) — not this pass's to touch.
    if (!stored) continue;
    const by = typeof record?.by === 'string' ? record.by : '';
    // Done is done, whatever the sweep decided: a record it *changed* no longer equals the fallback,
    // so this must be asked before the equality test or a resumed run miscounts its own work.
    if (by === SWEPT_BY) {
      alreadySwept++;
      continue;
    }
    if (idHalf(stored) !== guess.art) {
      guarded++;
      continue;
    }
    if (!MACHINE_BY.has(by)) {
      guarded++;
      continue;
    }
    const item = byVnum.get(guess.vnum)!;
    targets.push({
      vnum: guess.vnum,
      name: item.name,
      keywords: item.keywords,
      slot: item.slot!,
      currentArt: stored,
      fallbackId: guess.art,
    });
  }

  return { targets, alreadySwept, guarded, wordMatched };
}

/** The slot's candidates, grouped once for the whole run — the same join `matchArt` builds privately. */
export function candidatesBySlot(art: readonly ArtCandidate[]): ReadonlyMap<string, readonly ArtCandidate[]> {
  const bySlot = new Map<string, ArtCandidate[]>();
  for (const entry of art) {
    if (!entry.slot) continue;
    const list = bySlot.get(entry.slot) ?? [];
    list.push(entry);
    bySlot.set(entry.slot, list);
  }
  return bySlot;
}

/** The MUD's colour notation, out of the prompt — same pattern as `artmatch.words`. */
function stripped(text: string): string {
  return text.replace(/&[+-]?.?/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * What the model is asked. `buildColourPrompt`'s two lessons, applied to a longer vocabulary: the
 * candidate list is given **in full** (a model asked for "a sprite" invents one; a model handed 62
 * ids picks one), and the answer format is stated as the entire response, because *"Sure! I'd go
 * with..."* is a parsing problem nobody needs.
 *
 * The pack's display name rides beside each id because the ids are specific where the names are
 * generic — the id is the answer token, the name is what tells a model `armet` is a helmet.
 *
 * **The plainness rule is `fallbackFor`'s own, stated to the model.** The first trial moved plain
 * cloaks to `cape-tattered` — a quality the items never claimed. A7g's doc says why that is the wrong
 * kind of wrong: *a reviewer seeing a plain cape on an item they know is embroidered has learnt
 * something, where a tattered cape leaves them unable to tell a guess from a reading of the name.*
 */
export function buildArtPrompt(
  item: { readonly name: string; readonly keywords: readonly string[]; readonly slot: string },
  candidates: readonly ArtCandidate[],
): string {
  return [
    'You are choosing the picture for an item in a 2D fantasy role-playing game.',
    'The pictures are sprite sheets from a fixed list. Match what the item IS, not its colour.',
    '',
    `Item name: ${stripped(item.name)}`,
    item.keywords.length > 0 ? `Keywords: ${item.keywords.join(', ')}` : '',
    `Worn on: ${item.slot}`,
    '',
    'Choose the single best match from this list of picture ids:',
    ...candidates.map((c) => `- ${c.id}: ${c.name}`),
    '',
    'When several fit equally, choose the plainest one; only choose a damaged, decorated or magical',
    'variant when the item itself says so.',
    'Reply with exactly one id from the list and nothing else. No punctuation, no explanation.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * The model's answer turned back into a candidate id, or nothing.
 *
 * `readRampAnswer`'s posture — forgiving about the wrapper, strict about the token: *"arms-armour"*,
 * *"`arms-armour`."* and *"I would choose arms-armour"* all mean the same thing and all three happen.
 * The answer is scanned for candidate ids at **word boundaries** (an id must not sit inside a longer
 * hyphenated run, or a model that invents `cape-solid-fancy` would count as choosing `cape-solid`),
 * the earliest occurrence wins so a preamble cannot beat the choice, and a longer id beats a shorter
 * one starting at the same place so `cape-solid-tattered` is never misread as `cape-solid`. Anything
 * that names no listed id is a failure, not a guess — validated against the closed list rather than
 * trusted, which is the whole reason this is classification and not generation.
 */
export function readArtAnswer(answer: string, candidates: readonly ArtCandidate[]): string | undefined {
  const cleaned = answer.toLowerCase();
  const isIdChar = (ch: string | undefined): boolean => ch !== undefined && /[a-z0-9-]/.test(ch);

  let best: { id: string; at: number } | undefined;
  for (const candidate of candidates) {
    const id = candidate.id.toLowerCase();
    let from = 0;
    while (from <= cleaned.length - id.length) {
      const at = cleaned.indexOf(id, from);
      if (at < 0) break;
      const bounded = !isIdChar(cleaned[at - 1]) && !isIdChar(cleaned[at + id.length]);
      if (bounded) {
        if (!best || at < best.at || (at === best.at && id.length > best.id.length)) best = { id: candidate.id, at };
        break;
      }
      from = at + 1;
    }
  }
  return best?.id;
}

/**
 * The ramp that survives a sheet change, or nothing.
 *
 * Kept when the new sheet's own list carries it; re-derived from the name by A7h's own rule when it
 * does not (the colour the builder wrote is still the colour, whatever family now wears it); dropped
 * when the new sheet cannot say it at all — `arms-armour` declares recolours that resolve to no ramps,
 * and a ramp `isKnownArt` refuses would cost the item its picture three layers away. **No old ramp
 * means no new ramp**: colouring the uncoloured is `colourassign`'s deliberate, zone-scoped job, not
 * a side effect of changing sheets.
 */
export function rampAcross(
  oldRamp: string | undefined,
  newRamps: readonly string[] | undefined,
  item: { readonly name: string; readonly keywords: readonly string[] },
): string | undefined {
  if (!oldRamp) return undefined;
  if (!newRamps || newRamps.length === 0) return undefined;
  if (newRamps.includes(oldRamp)) return oldRamp;
  return rampFromName(item.name, item.keywords, newRamps)?.ramp;
}
