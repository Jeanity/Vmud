/**
 * `npm run artassign` — a picture for every item that can take one. **A7g**, owner's ask 2026-08-06.
 *
 * The matcher is `artmatch.ts` and is pure; this is the I/O around it. Read `artmatch.ts` for why the
 * slot is the join, why a slotless item is left alone, and why a guess lands in the **overlay** rather
 * than in the harvested catalogue.
 *
 * ## `--dry` first, because 16,421 rows is not a diff anybody reads twice
 *
 * The default is a dry run that reports and writes nothing. `--write` is the one that touches disk, and
 * it prints the same report first. That ordering is deliberate: the honest way to review this is to look
 * at the *shape* of the guesses (how many fell back, which slots), decide it is reasonable, and then let
 * the per-item review happen in the panel where the picture is actually visible.
 *
 * ## It never overwrites an authored `art`
 *
 * A vnum that already carries one in the overlay is skipped, so a run is repeatable and a hand-corrected
 * item stays corrected. Re-running after a re-harvest picks up only what is new.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LPC_ART, type ItemTemplate } from '@mygame/shared';

import { matchArt, type ArtGuess } from './artmatch.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CATALOGUE = join(REPO_ROOT, 'data', 'world', 'items.json');
const OVERLAY = join(REPO_ROOT, 'data', 'world', 'overrides', 'items.json');

function readCatalogue(): ItemTemplate[] {
  if (!existsSync(CATALOGUE)) {
    throw new Error(`${CATALOGUE} is not there. Run \`npm run worldgen\` first.`);
  }
  const parsed = JSON.parse(readFileSync(CATALOGUE, 'utf8')) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : Object.values(parsed as Record<string, unknown>);
  return list as ItemTemplate[];
}

function readOverlay(): Record<string, Record<string, unknown>> {
  if (!existsSync(OVERLAY)) return {};
  try {
    const parsed = JSON.parse(readFileSync(OVERLAY, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Record<string, unknown>>) : {};
  } catch {
    // A malformed overlay is a refusal rather than something to overwrite: it is hand-editable by design
    // and somebody's work is in there.
    throw new Error(`${OVERLAY} is not valid JSON. Fix or move it before running this.`);
  }
}

/** A few guesses of each kind, so the report shows what it is actually doing rather than only counting. */
function sample(guesses: readonly ArtGuess[], items: ReadonlyMap<number, ItemTemplate>, count: number): string[] {
  return guesses.slice(0, count).map((guess) => {
    const name = (items.get(guess.vnum)?.name ?? '?').replace(/&[+-]?.?/g, '');
    const how = guess.matched.length > 0 ? `on ${guess.matched.join('+')}` : 'fallback';
    return `    ${String(guess.vnum).padStart(7)}  ${name.slice(0, 44).padEnd(44)} → ${guess.art}  (${how})`;
  });
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const write = process.argv.includes('--write');
  const items = readCatalogue();
  const overlay = readOverlay();
  const authored = new Set(
    Object.entries(overlay)
      .filter(([, record]) => typeof record?.art === 'string')
      .map(([vnum]) => Number(vnum)),
  );

  const report = matchArt(items, LPC_ART, authored);
  const byName = new Map(items.map((item) => [item.vnum, item]));
  const matched = report.guesses.filter((guess) => guess.score > 0);
  const fell = report.guesses.filter((guess) => guess.score === 0);

  console.log(`[artassign] ${items.length} items, ${LPC_ART.length} art entries`);
  console.log(
    `[artassign] ${report.guesses.length} guessed — ${matched.length} on a shared word, ${fell.length} on a slot fallback`,
  );
  console.log(
    `[artassign] left alone: ${report.skipped['already-authored']} already authored, ` +
      `${report.skipped['no-slot']} carried rather than worn, ` +
      `${report.skipped['no-art-for-slot']} in a slot the pack has no art for` +
      (report.uncoveredSlots.length > 0 ? ` (${report.uncoveredSlots.join(', ')})` : ''),
  );

  // **Sorted worst-first for the samples.** A reviewer's time is best spent on the fallbacks and the
  // one-word matches; the high scorers are the ones least likely to be wrong.
  const worst = [...report.guesses].sort((a, b) => a.score - b.score || a.vnum - b.vnum);
  console.log('\n  strongest matches:');
  for (const line of sample([...worst].reverse(), byName, 8)) console.log(line);
  console.log('\n  weakest, which is where a review should start:');
  for (const line of sample(worst, byName, 8)) console.log(line);

  if (!write) {
    console.log('\n[artassign] dry run — nothing written. Re-run with --write to apply.');
  } else {
    for (const guess of report.guesses) {
      const key = String(guess.vnum);
      overlay[key] = {
        ...(overlay[key] ?? {}),
        art: guess.art,
        at: new Date().toISOString(),
        // Marked so a later reader — or a later version of this script — can tell a guess from a choice.
        // The panel shows it in the authored line, which is exactly where somebody reviewing wants it.
        by: 'artassign',
      };
    }
    mkdirSync(dirname(OVERLAY), { recursive: true });
    // Sorted by vnum so the diff is stable and a re-run does not reshuffle 16,000 lines.
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(overlay).sort((a, b) => Number(a) - Number(b))) sorted[key] = overlay[key];
    writeFileSync(OVERLAY, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`\n[artassign] wrote ${report.guesses.length} into data/world/overrides/items.json`);
    console.log('[artassign] every one is revertible per item with Restore harvested in the Items panel.');
  }
}
