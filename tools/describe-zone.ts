/**
 * Fill a zone's missing descriptions, one per distinct room title.
 *
 * The bulk path for the drafting the panel does one room at a time. It exists because a zone can
 * arrive with nothing: The Stag Forest has prose for **0 of 98 rooms**, and writing those by hand
 * through a form is not a tool, it is a weekend.
 *
 * ## One description per title, which is the world's own rule
 *
 * Measured on the shipped world: of 51 room titles that repeat, **51 share exactly one description
 * and 0 differ**. Diku forests are built from repeated cells on purpose — thirty rooms called "Under
 * the Canopy of Trees" are one place you walk through, not thirty places. So this generates per
 * *title* and applies the result to every room carrying it. For the Stag Forest that is 25 drafts
 * instead of 98, which is also the difference between twenty minutes and seventy-five.
 *
 * ## It saves, and that is a departure worth naming
 *
 * `ollama.ts` says the model drafts and the human commits, and the panel keeps that exactly. This
 * writes. The justification is that the alternative here is not "a human writes it" but "the room
 * stays blank forever", and everything it writes is: printed as it goes, marked authored with the
 * model and brief recorded, one click from Revert in the panel, and confined to the overlay — no
 * generated file is touched. Run with `--dry` to see the drafts without keeping any of them.
 *
 * Resumable by construction: a title whose rooms are already authored is skipped, so an interrupted
 * run continues where it stopped rather than paying for the work twice.
 *
 * ```
 * node --disable-warning=ExperimentalWarning tools/describe-zone.ts \
 *   --zone 260 --model qwen2.5:14b --theme "..." [--dry] [--limit 3]
 * ```
 */

const ADMIN = process.env['ADMIN_URL'] ?? 'http://127.0.0.1:8787/admin/api';
const TOKEN = process.env['GAME_ADMIN_TOKEN'] ?? 'dev';

interface RoomRow {
  readonly id: number;
  readonly name: string;
  readonly sector: string;
  readonly described: boolean;
  readonly authored: boolean;
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ADMIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  const zoneId = Number(arg('zone'));
  const model = arg('model');
  const theme = arg('theme');
  const dry = process.argv.includes('--dry');
  const limit = Number(arg('limit') ?? Infinity);

  if (!Number.isInteger(zoneId) || !model || !theme) {
    console.error('usage: --zone <id> --model <name> --theme "<one line>" [--dry] [--limit n]');
    process.exit(2);
  }

  const zone = await api<{ zone: { id: number; name: string }; rooms: RoomRow[] }>('GET', `/zones/${zoneId}/rooms`);

  // Grouped by title, and **ordered by how many rooms carry it** so the most-seen places in the zone
  // are written first. An interrupted run then leaves the world in the best state it could have:
  // thirty canopy rooms described and one burrow blank, rather than the reverse.
  const byTitle = new Map<string, RoomRow[]>();
  for (const room of zone.rooms) {
    const group = byTitle.get(room.name);
    if (group) group.push(room);
    else byTitle.set(room.name, [room]);
  }
  const titles = [...byTitle.entries()]
    .filter(([, rooms]) => !rooms.every((room) => room.described))
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, limit);

  const total = titles.reduce((sum, [, rooms]) => sum + rooms.length, 0);
  console.log(
    `${zone.zone.name}: ${zone.rooms.length} rooms, ${byTitle.size} distinct titles.\n` +
      `${titles.length} titles need prose, covering ${total} rooms. Model: ${model}.` +
      (dry ? '  [DRY RUN — nothing will be saved]' : ''),
  );

  let done = 0;
  let written = 0;
  let drafted = 0;
  let retried = 0;
  const failed: [string, RoomRow[]][] = [];
  const startedAt = Date.now();

  const attempt = async ([title, rooms]: [string, RoomRow[]], label: string): Promise<boolean> => {
    // The representative: the lowest id, so a re-run picks the same room and the neighbourhood the
    // model is shown does not shift between runs.
    const lead = rooms.reduce((best, room) => (room.id < best.id ? room : best));
    const brief = `${theme} This room: ${title}.`;

    process.stdout.write(`\n[${label}] ${title}  (${rooms.length} room${rooms.length === 1 ? '' : 's'}, ${lead.sector}) … `);

    let draft: { description: string; model: string; ms: number; retriedFor?: string[] };
    try {
      draft = await api('POST', `/rooms/${lead.id}/describe`, { model, brief });
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message.slice(0, 160)}`);
      return false;
    }
    drafted++;
    if (draft.retriedFor?.length) retried++;
    console.log(
      `${(draft.ms / 1000).toFixed(0)}s, ${draft.description.split(/\s+/).length} words` +
        (draft.retriedFor?.length ? `  (redrafted: ${draft.retriedFor.join(', ')})` : ''),
    );
    console.log(`    ${draft.description.replace(/\n+/g, '\n    ')}`);

    if (dry) return true;
    for (const room of rooms) {
      await api('PATCH', `/rooms/${room.id}`, { description: draft.description, by: draft.model, brief });
      written++;
    }
    return true;
  };

  for (const entry of titles) {
    done++;
    if (!(await attempt(entry, `${done}/${titles.length}`))) failed.push(entry);
  }

  // **A second pass over what failed.** The first full run of this script lost 5 titles to a run of
  // consecutive 120s timeouts and then recovered on its own — the model had stalled, not broken. A
  // transient failure should not leave a room blank until somebody notices and re-runs the whole
  // thing, and the retry costs nothing when there is nothing to retry.
  if (failed.length > 0) {
    console.log(`\n${failed.length} title${failed.length === 1 ? '' : 's'} failed. Trying each once more…`);
    const stillFailed: typeof failed = [];
    let n = 0;
    for (const entry of failed) {
      n++;
      if (!(await attempt(entry, `retry ${n}/${failed.length}`))) stillFailed.push(entry);
    }
    failed.length = 0;
    failed.push(...stillFailed);
  }

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(
    `\n${dry ? 'Drafted' : 'Wrote'} ${dry ? drafted : written} room${(dry ? drafted : written) === 1 ? '' : 's'} ` +
      // Counts what actually worked rather than what was attempted. The first version reported
      // "93 rooms from 25 titles" on a run where 5 of those titles produced nothing at all.
      `from ${drafted} of ${titles.length} titles in ${mins} minutes.` +
      (retried > 0 ? `\n${retried} draft${retried === 1 ? '' : 's'} were redrafted for breaking a rule.` : '') +
      (failed.length > 0
        ? `\n\nSTILL MISSING — ${failed.length} title${failed.length === 1 ? '' : 's'} failed twice:\n` +
          failed.map(([title]) => `  ${title}`).join('\n') +
          '\nRe-run this command; it skips everything already written.'
        : dry
          ? ''
          : '\nEvery one is marked authored and one click from Revert in the panel.'),
  );
}

await main();
