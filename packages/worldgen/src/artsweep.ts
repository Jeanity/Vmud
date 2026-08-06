/**
 * `npm run artsweep` — a second opinion on every picture A7g could only fall back on.
 *
 * The selection, the prompt and the answer-reading are `artpick.ts` and are pure; this is the I/O
 * around them: the catalogue, the overlay, and the Ollama round trip. Read `artpick.ts` for what is
 * sweepable and why the rule is *the stored art still equals the deterministic fallback*.
 *
 * ## Four modes, because an unattended model pass earns trust in stages
 *
 * - **default** — a dry listing: how many are sweepable, and the first few, model untouched.
 * - **`--calibrate N`** — asks the model about N items the *word matcher* already decided, and reports
 *   agreement. The word matches are not ground truth, but a model that cannot re-derive them is not
 *   to be trusted with the items that have no words at all.
 * - **`--trial N`** — the real question on the first N sweepable items, decisions printed, nothing
 *   written. The eyeball pass.
 * - **`--write`** — the sweep. Decisions land in the overlay as they accumulate (a flush every 200,
 *   so an interrupted run keeps its work), each marked `by: 'artsweep'`, which is also what makes a
 *   re-run resume instead of re-asking: 8,000 round trips is an hour-plus on a warm 14B model and
 *   none of it should ever be paid twice.
 *
 * ## The one rule the whole file leans on
 *
 * The model chooses from a **closed list and is validated against it** — an answer that names no
 * listed id is retried once with the failure named (`draftDescription`'s own budget), then counted
 * and left alone. A guess this pass cannot read costs the item nothing: it keeps the fallback it has.
 *
 * Temperature is pinned to 0, unlike room prose, and the difference is the point: prose wants variety
 * between presses of the button, a classification wants the same answer to the same question so that
 * a re-run over the same data is a no-op rather than a reshuffle.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LPC_ART, LPC_ART_BY_ID, formatArtId, parseArtId, type ItemTemplate } from '@mygame/shared';

import { matchArt, type ArtCandidate } from './artmatch.ts';
import { SWEPT_BY, buildArtPrompt, candidatesBySlot, rampAcross, readArtAnswer, sweepSet, type SweepTarget } from './artpick.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CATALOGUE = join(REPO_ROOT, 'data', 'world', 'items.json');
const OVERLAY = join(REPO_ROOT, 'data', 'world', 'overrides', 'items.json');

/** Where Ollama listens — the same default and override `server/src/ollama.ts` uses. */
const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434';

/** Generous for the same reason the server's is: a cold 14B model loads weights before its first token. */
const TIMEOUT_MS = 120_000;

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

/** Sorted by vnum so the diff is stable and a flush mid-run does not reshuffle 16,000 lines. */
function writeOverlay(overlay: Record<string, Record<string, unknown>>): void {
  mkdirSync(dirname(OVERLAY), { recursive: true });
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(overlay).sort((a, b) => Number(a) - Number(b))) sorted[key] = overlay[key];
  writeFileSync(OVERLAY, `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * One question to the model. Fatal failures (Ollama unreachable, model missing) throw so the run
 * stops rather than paying 8,000 timeouts; an empty or unusable *answer* merely returns nothing.
 */
async function askOllama(model: string, prompt: string): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        // Longer than the default five minutes, so the pauses in a supervised run (reading a trial,
        // deciding to go on) do not cost a weight reload each time.
        keep_alive: '30m',
        // Temperature 0 for repeatability; the answer is one id, so the token budget is a cap on
        // rambling and on worst-case latency, not a constraint on the choice.
        options: { temperature: 0, num_predict: 64 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const why = (err as Error).name === 'TimeoutError'
      ? `${model} did not answer within ${TIMEOUT_MS / 1000}s`
      : `could not reach Ollama at ${OLLAMA_URL}: ${(err as Error).message}`;
    throw new Error(why);
  }
  if (!response.ok) {
    // Ollama's own message names the model in the common failure; a status code does not.
    const detail = await response.text().catch(() => '');
    throw new Error(`Ollama refused (${response.status}): ${detail.slice(0, 300)}`);
  }
  const body = (await response.json().catch(() => ({}))) as { response?: unknown };
  return typeof body.response === 'string' && body.response.trim() ? body.response : undefined;
}

/** The model's choice for one item, with `draftDescription`'s one-retry budget when it cannot be read. */
async function chooseArt(
  model: string,
  item: { readonly name: string; readonly keywords: readonly string[]; readonly slot: string },
  candidates: readonly ArtCandidate[],
): Promise<string | undefined> {
  const prompt = buildArtPrompt(item, candidates);
  const first = await askOllama(model, prompt);
  const read = first === undefined ? undefined : readArtAnswer(first, candidates);
  if (read) return read;
  const scolded = `${prompt}\n\nYour previous reply was not one of the listed ids. Reply with exactly one id, copied verbatim from the list.`;
  const second = await askOllama(model, scolded);
  return second === undefined ? undefined : readArtAnswer(second, candidates);
}

function plain(name: string): string {
  return name.replace(/&[+-]?.?/g, '');
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const numberAfter = (flag: string): number | undefined => {
    const at = argv.indexOf(flag);
    if (at < 0) return undefined;
    const value = Number(argv[at + 1]);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} wants a positive integer`);
    return value;
  };
  const trial = numberAfter('--trial');
  const calibrate = numberAfter('--calibrate');
  const limit = numberAfter('--limit');
  const modelAt = argv.indexOf('--model');
  const model = modelAt >= 0 ? argv[modelAt + 1] : 'qwen2.5:14b';
  if (!model) throw new Error('--model wants a model name, e.g. --model qwen2.5:14b');
  const vnums = new Set<number>();
  for (let at = argv.indexOf('--vnum'); at >= 0; at = argv.indexOf('--vnum', at + 1)) {
    const vnum = Number(argv[at + 1]);
    if (!Number.isInteger(vnum)) throw new Error('--vnum wants an item vnum');
    vnums.add(vnum);
  }

  const items = readCatalogue();
  const overlay = readOverlay();
  const bySlot = candidatesBySlot(LPC_ART);
  const set = sweepSet(items, LPC_ART, overlay);
  const chosen = set.targets.filter((t) => vnums.size === 0 || vnums.has(t.vnum));
  const byVnum = new Map(items.map((item) => [item.vnum, item]));

  console.log(`[artsweep] ${items.length} items; recomputed: ${set.wordMatched} word-matched, ${set.targets.length + set.alreadySwept + set.guarded} on the machine fallback`);
  console.log(
    `[artsweep] ${set.targets.length} sweepable — ${set.alreadySwept} already swept, ` +
      `${set.guarded} left alone because their art or provenance may be somebody's choice`,
  );

  /** Runs the model over targets, applying each decision through `apply`. Shared by trial and write. */
  const run = async (
    targets: readonly SweepTarget[],
    apply: (target: SweepTarget, choice: string) => void,
    say: (line: string) => void,
  ): Promise<{ confirmed: number; changed: number; unread: number }> => {
    const counts = { confirmed: 0, changed: 0, unread: 0 };
    const started = Date.now();
    for (const [index, target] of targets.entries()) {
      const candidates = bySlot.get(target.slot);
      if (!candidates || candidates.length === 0) continue;
      const choice = await chooseArt(model, target, candidates);
      if (!choice) {
        counts.unread++;
        say(`    ${String(target.vnum).padStart(7)}  ${plain(target.name).slice(0, 40).padEnd(40)}  (unreadable answer — kept)`);
      } else if (choice === target.fallbackId) {
        counts.confirmed++;
        apply(target, choice);
      } else {
        counts.changed++;
        say(`    ${String(target.vnum).padStart(7)}  ${plain(target.name).slice(0, 40).padEnd(40)}  ${target.fallbackId} → ${choice}`);
        apply(target, choice);
      }
      const done = index + 1;
      if (done % 25 === 0 || done === targets.length) {
        const perItem = (Date.now() - started) / done;
        const left = Math.round(((targets.length - done) * perItem) / 1000);
        console.log(
          `[artsweep] ${done}/${targets.length} — ${counts.changed} changed, ${counts.confirmed} confirmed, ` +
            `${counts.unread} unreadable, ~${left}s left`,
        );
      }
    }
    return counts;
  };

  /** One decision into the overlay. The ramp crosses the sheet change only where it stays sayable. */
  const decide = (target: SweepTarget, choice: string): { art: string; rampDropped: boolean } => {
    if (choice === target.fallbackId) return { art: target.currentArt, rampDropped: false };
    const oldRamp = parseArtId(target.currentArt).ramp;
    const ramp = rampAcross(oldRamp, LPC_ART_BY_ID.get(choice)?.recolours?.ramps, target);
    return { art: formatArtId(choice, ramp), rampDropped: oldRamp !== undefined && ramp === undefined };
  };

  if (calibrate !== undefined) {
    // The word-matched guesses are the only labelled data there is: not ground truth, but a model
    // that cannot re-derive them has no business re-deciding the items that have no words at all.
    // The stored overlay does not matter here — this compares the model against the *word matcher*,
    // so the pool is every recomputed word match. Every k-th one, so the sample crosses slots and
    // zones rather than reading one shelf.
    const wordMatched = matchArt(items, LPC_ART, new Set()).guesses.filter((g) => g.score > 0);
    const step = Math.max(1, Math.floor(wordMatched.length / calibrate));
    const sample = wordMatched.filter((_, index) => index % step === 0).slice(0, calibrate);
    console.log(`\n[artsweep] calibrating ${model} against ${sample.length} word-matched items (every ${step}th of ${wordMatched.length})`);
    let agreed = 0;
    let unread = 0;
    for (const guess of sample) {
      const item = byVnum.get(guess.vnum);
      const candidates = item?.slot ? bySlot.get(item.slot) : undefined;
      if (!item || !item.slot || !candidates) continue;
      const choice = await chooseArt(model, { name: item.name, keywords: item.keywords, slot: item.slot }, candidates);
      if (!choice) unread++;
      else if (choice === guess.art) agreed++;
      else {
        console.log(
          `    ${String(guess.vnum).padStart(7)}  ${plain(item.name).slice(0, 40).padEnd(40)}  word: ${guess.art}  model: ${choice}`,
        );
      }
    }
    const asked = sample.length - unread;
    console.log(
      `\n[artsweep] agreement: ${agreed}/${asked}${asked > 0 ? ` (${Math.round((100 * agreed) / asked)}%)` : ''}, ` +
        `${unread} unreadable. Disagreements above are worth reading: either side may be the wrong one.`,
    );
    console.log('[artsweep] nothing written.');
  } else if (trial !== undefined) {
    const targets = chosen.slice(0, trial);
    console.log(`\n[artsweep] trial: asking ${model} about ${targets.length} of the ${chosen.length} sweepable, writing nothing\n`);
    const counts = await run(targets, () => {}, (line) => console.log(line));
    console.log(
      `\n[artsweep] trial over ${targets.length}: ${counts.changed} would change, ${counts.confirmed} confirmed as they are, ` +
        `${counts.unread} unreadable. Nothing written.`,
    );
  } else if (!write) {
    console.log('\n  first of the sweepable, oldest vnum first:');
    for (const target of chosen.slice(0, 12)) {
      console.log(`    ${String(target.vnum).padStart(7)}  ${plain(target.name).slice(0, 44).padEnd(44)} wears ${target.currentArt}`);
    }
    console.log(
      '\n[artsweep] dry run — the model was not asked and nothing was written.\n' +
        '[artsweep] --calibrate 40 measures the model against the word matches; --trial 20 asks the real\n' +
        '[artsweep] question without writing; --write runs the sweep (resumable; flushes every 200).',
    );
  } else {
    const targets = limit === undefined ? chosen : chosen.slice(0, limit);
    console.log(`\n[artsweep] sweeping ${targets.length} with ${model} — decisions land in the overlay as they accumulate\n`);
    let pending = 0;
    let rampsDropped = 0;
    const apply = (target: SweepTarget, choice: string): void => {
      const { art, rampDropped } = decide(target, choice);
      if (rampDropped) rampsDropped++;
      const key = String(target.vnum);
      overlay[key] = { ...(overlay[key] ?? {}), art, at: new Date().toISOString(), by: SWEPT_BY };
      pending++;
      if (pending % 200 === 0) writeOverlay(overlay);
    };
    try {
      const counts = await run(targets, apply, (line) => console.log(line));
      console.log(
        `\n[artsweep] ${counts.changed} changed, ${counts.confirmed} confirmed, ${counts.unread} unreadable and kept` +
          (rampsDropped > 0 ? `, ${rampsDropped} colour(s) dropped because the new sheet cannot wear them` : ''),
      );
      console.log('[artsweep] the overlay diff is the full listing; every one is revertible per item with Restore harvested in the Items panel.');
    } finally {
      // The flush that makes an interruption cost at most 199 answers rather than the run.
      if (pending > 0) {
        writeOverlay(overlay);
        console.log(`[artsweep] overlay written — ${pending} record(s) now carry by: '${SWEPT_BY}'.`);
      }
    }
  }
}
