/**
 * Giving 1,503 mobs a face — the runner half of {@link mobpick}.
 *
 * `artsweep.ts`'s shape pointed at creatures: the deciding is pure and tested in `mobpick.ts`, and
 * everything that touches a socket or a file is here, so the hard part can be re-run in a unit test
 * and this part can be re-run against a live Ollama without pretending to be tested.
 *
 * ## Two passes, and only the second costs anything
 *
 * The word matcher settles 169 creatures for free and deterministically. Everything it cannot
 * answer goes to the model, one short question each. **`--words` runs the free pass alone**, which
 * is the sensible first move: it is instant, it is auditable, and it turns 169 mobs from men into
 * trolls and kobolds without anybody waiting.
 *
 * ## What it writes, and what it will not touch
 *
 * Output is `data/world/overrides/mobs.json` — the same `MobOverride` file the panel edits, using
 * the `sprite` field A9 already made authorable. So a sweep result is an ordinary override an
 * operator can see and change, not a parallel format.
 *
 * **A choice is never overwritten.** A record whose `sprite` is already set is skipped, whoever set
 * it — the sweep only ever fills a blank. That is A7g's contract and it is the reason a run can be
 * interrupted and resumed: what is done stays done, and what is not gets asked again.
 *
 * ## Usage
 *
 * ```
 * npm run mobsweep -- --words              # free pass only, instant
 * npm run mobsweep -- --model qwen2.5:14b  # and ask the model about the rest
 * npm run mobsweep -- --model qwen2.5:14b --limit 40   # a trial first, which is the honest order
 * ```
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BODY_SHAPES, HEAD_SHAPES, creatureSheets } from '@mygame/shared';

import {
  bodyFromWords,
  buildMobPrompt,
  readMobAnswer,
  shapeFromWords,
  spriteKey,
  type MobFacts,
} from './mobpick.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SPAWNS = join(REPO_ROOT, 'data', 'world', 'spawns');
const OVERRIDES = join(REPO_ROOT, 'data', 'world', 'overrides');
const MOBS_FILE = join(OVERRIDES, 'mobs.json');
const AUTHORED_FILE = join(OVERRIDES, 'mobs-authored.json');

const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
const TIMEOUT_MS = 120_000;

/** Every creature in the world that could wear a face, harvested and authored alike. */
export function readCreatures(): MobFacts[] {
  const out: MobFacts[] = [];
  if (existsSync(SPAWNS)) {
    for (const file of readdirSync(SPAWNS).filter((f) => f.endsWith('.json'))) {
      const parsed = JSON.parse(readFileSync(join(SPAWNS, file), 'utf8')) as { templates?: MobFacts[] };
      for (const t of parsed.templates ?? []) out.push(t);
    }
  }
  if (existsSync(AUTHORED_FILE)) {
    const parsed = JSON.parse(readFileSync(AUTHORED_FILE, 'utf8')) as Record<string, unknown>;
    const rows = (parsed['mobs'] ?? parsed) as Record<string, { name?: string; keywords?: string[] }>;
    for (const [vnum, row] of Object.entries(rows)) {
      if (row?.name) out.push({ vnum: Number(vnum), name: row.name, ...(row.keywords ? { keywords: row.keywords } : {}) });
    }
  }
  // A vnum can appear in several zone files; one face per creature, not one per placement.
  const seen = new Set<number>();
  return out.filter((m) => (seen.has(m.vnum) ? false : (seen.add(m.vnum), true)));
}

/**
 * The override file is a **flat map of vnum to override**, with no wrapper.
 *
 * Worth a note because the first version of this sweep assumed `{ mobs: { … } }` — the shape
 * `mobs-authored.json` uses — and wrote 161 rows into a nested `mobs` key that the loader cannot
 * see. Nothing failed: the file was valid JSON, the run reported success, and the boot log still
 * said fourteen templates authored. **The tell was the boot log, not the writer**, which is the
 * argument for reading it after a bulk write rather than trusting the count the writer prints.
 */
type OverrideFile = Record<string, Record<string, unknown>>;

function readOverrides(): OverrideFile {
  if (!existsSync(MOBS_FILE)) return {};
  return JSON.parse(readFileSync(MOBS_FILE, 'utf8')) as OverrideFile;
}

/**
 * One question, and the failure split `artsweep` learned to make.
 *
 * An unreachable model or a timeout **throws** — the run stops rather than paying fifteen hundred
 * timeouts to discover Ollama is not running. An answer that is merely unusable returns nothing and
 * that one creature is left for a human.
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
        keep_alive: '30m',
        options: { temperature: 0, num_predict: 16 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      (err as Error).name === 'TimeoutError'
        ? `${model} did not answer within ${TIMEOUT_MS / 1000}s`
        : `could not reach Ollama at ${OLLAMA_URL}: ${(err as Error).message}`,
    );
  }
  if (!response.ok) throw new Error(`Ollama refused (${response.status}): ${(await response.text().catch(() => '')).slice(0, 200)}`);
  const body = (await response.json().catch(() => ({}))) as { response?: unknown };
  return typeof body.response === 'string' && body.response.trim() ? body.response : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const wordsOnly = argv.includes('--words');
  const model = flag('model');
  const limit = Number(flag('limit') ?? Number.POSITIVE_INFINITY);
  const dryRun = argv.includes('--dry-run');

  if (!wordsOnly && !model) {
    console.error('usage: mobsweep --words | --model <name> [--limit N] [--dry-run]');
    process.exitCode = 2;
    return;
  }

  const creatures = readCreatures();
  const file = readOverrides();
  const rows = file;

  let byWord = 0;
  let byModel = 0;
  let skipped = 0;
  let refused = 0;
  const asked: MobFacts[] = [];

  const assign = (m: MobFacts, head: string): boolean => {
    const key = spriteKey({ body: bodyFromWords(m, BODY_SHAPES), head });
    // Never ship a key the renderer cannot draw — the whole point of resolving before writing.
    if (!creatureSheets(key)) return false;
    const row = rows[String(m.vnum)] ?? {};
    row['sprite'] = key;
    rows[String(m.vnum)] = row;
    return true;
  };

  for (const m of creatures) {
    // A choice is never overwritten, whoever made it. This is what makes a run resumable.
    if (rows[String(m.vnum)]?.['sprite'] !== undefined) {
      skipped++;
      continue;
    }
    const head = shapeFromWords(m, HEAD_SHAPES);
    if (head) {
      if (assign(m, head)) byWord++;
      else refused++;
      continue;
    }
    asked.push(m);
  }

  console.log(
    `[mobsweep] ${creatures.length} creature(s): ${byWord} settled by name, ${skipped} already chosen, ` +
      `${asked.length} for the model`,
  );

  if (!wordsOnly && model) {
    const queue = asked.slice(0, Number.isFinite(limit) ? limit : asked.length);
    console.log(`[mobsweep] asking ${model} about ${queue.length}…`);
    let done = 0;
    for (const m of queue) {
      const answer = await askOllama(model, buildMobPrompt(m, HEAD_SHAPES));
      const shape = answer ? readMobAnswer(answer, HEAD_SHAPES) : undefined;
      if (shape && assign(m, shape)) byModel++;
      else refused++;
      if (++done % 50 === 0) console.log(`[mobsweep]   ${done}/${queue.length}…`);
    }
  }

  if (dryRun) {
    console.log('[mobsweep] --dry-run: nothing written');
    return;
  }
  mkdirSync(OVERRIDES, { recursive: true });
  writeFileSync(MOBS_FILE, `${JSON.stringify(file, null, 1)}\n`, 'utf8');
  console.log(
    `[mobsweep] wrote ${byWord + byModel} face(s) to mobs.json — ${byWord} by name, ${byModel} by model` +
      (refused > 0 ? `, ${refused} left for a human` : ''),
  );
}

if (import.meta.filename === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(`[mobsweep] ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
