/**
 * What a thing answers to — the authored keyword lists, finally read.
 *
 * Every harvested item carries Duris' own keyword list (`ItemTemplate.keywords`, measured at 16,421
 * of 16,421 entries), and until this file existed nothing player-facing read it: every matcher split
 * the *display name*, so `wield two-handed` failed on "a black two-handed sword" while the word sat
 * unread in the catalogue. Mobs have the same field (`MobTemplate.keywords`) and had the same bug —
 * `kill watch` found nothing, with `['sentry', 'guard', 'watch']` authored on the sentry guard.
 *
 * ## Union, not replacement — and this was measured, not chosen
 *
 * The obvious fix is to *replace* the name-split with the authored list, and it is wrong twice over:
 *
 * - **Items**: 6,121 of 16,421 (37.3%) have a display-name word that is not in their authored list —
 *   `pair` (565 items), `small` (280), `set` (123), `black` (111). `remove pair` works today on every
 *   "pair of stiff work gloves", and replacement silently kills it.
 * - **Mobs**: replacement makes 129 of 1,503 templates unreachable by the head noun of their own
 *   display name — "the deputy chief" stops answering to `chief` — and leaves 8 answering to **no
 *   word visible on screen at all** ("a bored soldier" authored only as `guard`).
 *
 * The union costs nothing that is not already true: every word it admits either works today or was
 * authored to work. So the rule is `authored ∪ name-split`, both halves colour-stripped.
 *
 * ## The two guards, each against a measured hazard
 *
 * - `keywords ?? []`: the catalogue loader shape-checks `vnum`/`name`/`size` and blind-casts the
 *   rest, and `data/world/items.json` is git-ignored and hand-editable. A row without `keywords`
 *   would put `undefined` here, and an uncaught throw inside `wear` escapes the socket handler and
 *   takes the server down for everyone. A missing list means the name-split, not a crash.
 * - `stripColour` on the **authored** half too: 10 authored keywords carry colour codes — `book&n`
 *   (vnum 134032), `&+wpeppermint` (195) — and stripping only the fallback would leave the new
 *   canonical rule shipping with the old bug inside it, on the path whose whole job is to define
 *   what a player may type.
 *
 * Builder tokens (`_binder_`-style, wrapped in underscores) are dropped: they are authoring
 * machinery, not words, and matching them would let a player type a thing no screen ever shows.
 */

import { wordsFromName, type Item, type ItemTemplate } from '@mygame/shared';

/** An authored keyword list made fit for a player's mouth: colour-stripped, builder tokens dropped. */
export function playerWords(authored: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const word of authored ?? []) {
    // The builder-token test runs on the *raw* word, before the split — the split's own character
    // class eats underscores, so testing afterwards would see `binder` and wave it through.
    if (/^_.+_$/.test(word)) continue;
    // The authored word may itself be several once its colour code is stripped — `&+wpeppermint
    // schnappes&n` is one entry in the file — so each survivor is re-split rather than trusted.
    out.push(...wordsFromName(word));
  }
  return out;
}

/**
 * Every word an item answers to: the authored list unioned with its display name's words.
 *
 * Takes the template rather than looking it up, so this stays a pure function a test can feed — the
 * caller resolves `vnumOf(item)` against its catalogue, exactly as `reset.ts`'s census is fed. An
 * item with no template (the authored starter kit, whose ids are bare words with no vnum) answers to
 * its name alone, which is everything it ever answered to.
 */
export function wordsForItem(item: Item, template: ItemTemplate | undefined): readonly string[] {
  const fromName = wordsFromName(item.name);
  if (!template) return fromName;
  return [...new Set([...playerWords(template.keywords), ...fromName])];
}

/** The same union for a mob, whose authored list lives on its spawn template. */
export function wordsForMob(name: string, authored: readonly string[] | undefined): readonly string[] {
  return [...new Set([...playerWords(authored), ...wordsFromName(name)])];
}
