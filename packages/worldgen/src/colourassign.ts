/**
 * `npm run colourassign` — a colour for a zone's loot, from the names it already has. **A7h.**
 *
 * `colourmatch.ts` decides *whose loot is whose*; `shared/artcolour.ts` decides *what colour a name
 * asks for*; this is the I/O around both. Same shape as `artassign`, deliberately, because an operator
 * who has run one should not have to learn the other: **dry by default**, `--write` to apply, a report
 * that names what it skipped, and every change landing in the overlay the panel already edits.
 *
 * ```
 * npm run colourassign                    # every loaded zone, dry
 * npm run colourassign -- --zone 168      # one zone
 * npm run colourassign -- --zone 168 --write
 * ```
 *
 * ## The model is not called here, and that is the point
 *
 * A7f's matcher tries the item's own name first and only asks Ollama when that says nothing. **This pass
 * uses the name half alone.** A bulk run is exactly where a per-item model call stops being reasonable —
 * a hundred items is a hundred round trips at 0.6 s warm and 67 s cold, to answer a question the name
 * usually answers for free.
 *
 * So an item whose name names no colour is **left alone**, not guessed at. The Suggest button in the
 * Items panel is where a model gets consulted, one item at a time, by somebody who has decided that item
 * is worth the wait. The bulk pass does the cheap majority; the button does the interesting remainder.
 *
 * ## Never over an existing choice
 *
 * An item that already carries a ramp is skipped, whoever put it there. That makes a re-run safe and
 * makes the pass composable with the panel: colour a zone, hand-fix the three that came out wrong, run
 * it again after a re-harvest, and the three stay fixed.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LPC_ART_BY_ID,
  formatArtId,
  parseArtId,
  rampFromName,
  type ItemTemplate,
  type ZoneSpawns,
} from '@mygame/shared';

import { lootOf, type ColourProposal, type ColourReport, type ColourSkip } from './colourmatch.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CATALOGUE = join(REPO_ROOT, 'data', 'world', 'items.json');
const OVERLAY = join(REPO_ROOT, 'data', 'world', 'overrides', 'items.json');
const SPAWNS = join(REPO_ROOT, 'data', 'world', 'spawns');

function readCatalogue(): Map<number, ItemTemplate> {
  if (!existsSync(CATALOGUE)) throw new Error(`${CATALOGUE} is not there. Run \`npm run worldgen\` first.`);
  const parsed = JSON.parse(readFileSync(CATALOGUE, 'utf8')) as unknown;
  const list = (Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : Object.values(parsed as Record<string, unknown>)) as ItemTemplate[];
  return new Map(list.map((item) => [item.vnum, item]));
}

function readOverlay(): Record<string, Record<string, unknown>> {
  if (!existsSync(OVERLAY)) return {};
  try {
    const parsed = JSON.parse(readFileSync(OVERLAY, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Record<string, unknown>>) : {};
  } catch {
    throw new Error(`${OVERLAY} is not valid JSON. Fix or move it before running this.`);
  }
}

/** Which zones to walk. A named one, or every population file on disk. */
function zonesToWalk(only: number | undefined): { zone: number; spawns: ZoneSpawns }[] {
  const out: { zone: number; spawns: ZoneSpawns }[] = [];
  if (!existsSync(SPAWNS)) return out;
  for (const file of readdirSync(SPAWNS)) {
    if (!file.endsWith('.json')) continue;
    const spawns = JSON.parse(readFileSync(join(SPAWNS, file), 'utf8')) as ZoneSpawns;
    if (only !== undefined && spawns.zone !== only) continue;
    out.push({ zone: spawns.zone, spawns });
  }
  return out.sort((a, b) => a.zone - b.zone);
}

/**
 * The proposals for one set of item vnums.
 *
 * `art` is read from the **overlay first and the catalogue second**, which is the order the game itself
 * resolves them in — A7g wrote every art into the overlay, so reading the catalogue alone would find
 * nothing and this pass would report that no item has art at all.
 */
export function proposeFor(
  vnums: readonly number[],
  catalogue: ReadonlyMap<number, ItemTemplate>,
  overlay: Readonly<Record<string, Record<string, unknown>>>,
): ColourReport {
  const proposals: ColourProposal[] = [];
  const skipped: Record<ColourSkip, number> = {
    'no-art': 0,
    'not-recolourable': 0,
    'already-coloured': 0,
    'skin-toned-art': 0,
    'no-colour-in-the-name': 0,
  };

  for (const vnum of vnums) {
    const item = catalogue.get(vnum);
    if (!item) continue;
    const authored = overlay[String(vnum)];
    const art = typeof authored?.art === 'string' ? authored.art : item.art;
    if (typeof art !== 'string' || !art) {
      skipped['no-art']++;
      continue;
    }
    const { id, ramp } = parseArtId(art);
    if (ramp) {
      skipped['already-coloured']++;
      continue;
    }
    const entry = LPC_ART_BY_ID.get(id);
    if (!entry?.recolours) {
      skipped['not-recolourable']++;
      continue;
    }
    // **Art drawn in the `body` material is skin, and recolouring it recolours flesh.** Found by running
    // this: *"a heavy black nosering"* and *"an oozing lump of brown slime"* both wear `head-nose-big`,
    // the only art the `nose` slot has, whose base ramp is a skin tone — so *black* would have blackened
    // the nose rather than the ring. The rule is general: a `body` ramp belongs to the character's own
    // body layer, never to a thing worn on it.
    //
    // Skipped **here and not in the matcher**, deliberately. This pass is unattended and should be the
    // conservative one; the Suggest button is a person looking at the result, and they can have the
    // control. Same split §8 draws everywhere else — the automatic path is timid, the human path is not.
    if (entry.recolours.material === 'body') {
      skipped['skin-toned-art']++;
      continue;
    }
    const found = rampFromName(item.name, item.keywords, entry.recolours.ramps);
    if (!found) {
      skipped['no-colour-in-the-name']++;
      continue;
    }
    proposals.push({
      vnum,
      name: item.name,
      art: formatArtId(id, found.ramp),
      ramp: found.ramp,
      because: found.because,
    });
  }
  return { proposals, skipped };
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const write = process.argv.includes('--write');
  const zoneAt = process.argv.indexOf('--zone');
  const only = zoneAt >= 0 ? Number(process.argv[zoneAt + 1]) : undefined;
  if (zoneAt >= 0 && !Number.isInteger(only)) throw new Error('--zone wants a zone id, e.g. --zone 168');

  const catalogue = readCatalogue();
  const overlay = readOverlay();
  const zones = zonesToWalk(only);
  if (zones.length === 0) {
    console.log(only === undefined ? '[colourassign] no population files found' : `[colourassign] no zone ${only}`);
  }

  const byVnum = new Map<number, ColourProposal>();
  const totals: Record<ColourSkip, number> = {
    'no-art': 0,
    'not-recolourable': 0,
    'already-coloured': 0,
    'skin-toned-art': 0,
    'no-colour-in-the-name': 0,
  };

  for (const { zone, spawns } of zones) {
    const loot = lootOf(spawns);
    if (loot.length === 0) continue;
    const report = proposeFor(loot, catalogue, overlay);
    for (const key of Object.keys(totals) as ColourSkip[]) totals[key] += report.skipped[key];
    // **One entry per item, not per zone it appears in.** A catalogue entry can be loot in several
    // zones — measured, some are in three — and it is one item with one colour, so pooling them by vnum
    // is what makes the total say *items changed* rather than *rows printed*. The per-zone listing below
    // still shows it under each zone, which is right: somebody reviewing zone 350 wants all of zone 350.
    for (const proposal of report.proposals) {
      if (!byVnum.has(proposal.vnum)) byVnum.set(proposal.vnum, proposal);
    }
    if (report.proposals.length === 0) continue;
    console.log(`\n  zone ${zone} — ${loot.length} items of loot, ${report.proposals.length} coloured`);
    for (const p of report.proposals) {
      const name = p.name.replace(/&[+-]?.?/g, '');
      console.log(`    ${String(p.vnum).padStart(7)}  ${name.slice(0, 42).padEnd(42)} → ${p.ramp}  (${p.because})`);
    }
  }

  const everything = [...byVnum.values()];
  console.log(
    `\n[colourassign] ${everything.length} item(s) coloured across ${zones.length} zone(s)` +
      (only === undefined ? '' : ` — zone ${only} only`),
  );
  console.log(
    `[colourassign] left alone: ${totals['no-colour-in-the-name']} whose name names no colour, ` +
      `${totals['not-recolourable']} whose art has no palettes, ` +
      `${totals['already-coloured']} already coloured, ` +
      `${totals['skin-toned-art']} whose art is skin rather than cloth, ` +
      `${totals['no-art']} with no art at all`,
  );

  if (!write) {
    console.log('\n[colourassign] dry run — nothing written. Re-run with --write to apply.');
  } else {
    for (const p of everything) {
      const key = String(p.vnum);
      overlay[key] = { ...(overlay[key] ?? {}), art: p.art, at: new Date().toISOString(), by: 'colourassign' };
    }
    mkdirSync(dirname(OVERLAY), { recursive: true });
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(overlay).sort((a, b) => Number(a) - Number(b))) sorted[key] = overlay[key];
    writeFileSync(OVERLAY, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`\n[colourassign] wrote ${everything.length} into data/world/overrides/items.json`);
    console.log('[colourassign] every one is revertible per item with Restore harvested in the Items panel.');
  }
}
