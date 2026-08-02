/**
 * Drafting room prose with a local model.
 *
 * Owner-requested: pick a room, type `forest by a stream`, get a description written in the style of
 * the rest of the world. Track A, and the first genuinely useful piece of the Ollama work — it needs
 * no geometry, no vnum space and no new storage, because it writes into A5's overlay through A5's
 * editor.
 *
 * ## Three rules this file exists to keep
 *
 * **The model drafts; the human commits.** Generation returns text and saves nothing. The draft lands
 * in the editor's box, where it can be read, rewritten, coloured, or thrown away, and only then does
 * the ordinary `PATCH /rooms/:id` write it. Auto-saving would put unreviewed machine prose into the
 * world, and worse, would make *not* keeping it the expensive path.
 *
 * **The server calls Ollama, not the browser.** The panel is a page on 5274 and Ollama listens on
 * 11434, so a direct call is cross-origin and needs `OLLAMA_ORIGINS` set on a service the panel does
 * not own. Going through the game server costs one proxy route, avoids that entirely, and keeps
 * `DESIGN-admin-panel.md` §1 intact — the server is the only writer, and the thing writing prose is
 * on the server's side of the line.
 *
 * **Never in the tick.** `CLAUDE.md` rule 3 requires the simulation to be deterministic, and a model
 * is the least deterministic thing on the machine. This runs on the admin router's async path, which
 * is I/O and nothing else; the 100 ms tick never waits on it. Nothing here may ever be imported by
 * simulation code.
 *
 * ## Style is shown, not described
 *
 * The house style is Duris' style and it is on disk in quantity, so the prompt is **few-shot**: real
 * descriptions from the same zone, verbatim. Telling a model to write "like a MUD" produces a
 * pastiche of every MUD; showing it three rooms from the castle it is standing in produces the
 * castle. The numeric constraints below are measured from the world rather than chosen — see
 * {@link STYLE}.
 */

/** Where Ollama listens. Overridable for a model running on another machine on the LAN. */
const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434';

/**
 * How long to wait for a draft.
 *
 * Generous, because a 14B model on a cold start can spend thirty seconds loading weights before it
 * emits a token, and the failure an operator hates most is one that gives up just before it would
 * have worked. This is a local tool with one user; a request held open for two minutes costs nothing.
 */
const TIMEOUT_MS = 120_000;

/**
 * The house style, **measured from the shipped world rather than chosen**.
 *
 * Across IceCrag's 216 descriptions: a median of 115 words and 7 sentences, with the middle half
 * between 97 and 130 words. Only 16 of 216 mention their exits, and exactly 1 of 216 uses the second
 * person — the prose describes a place, it does not address a visitor. A model told "write a room
 * description" reaches for *"You find yourself in a dark room. Exits: north, south."*, which is wrong
 * on both counts, so both are stated.
 */
const STYLE = {
  minWords: 90,
  maxWords: 140,
  sentences: 7,
} as const;

export interface OllamaModel {
  readonly name: string;
  /** Bytes on disk — shown in the picker, because a 9 GB model is a different proposition to a 1 GB one. */
  readonly size: number;
  readonly parameters: string | null;
}

/** One room offered to the model as an example or as context. */
export interface ProseSample {
  readonly name: string;
  readonly description: string;
  /** How it relates to the room being written — `null` for a style sample from elsewhere in the zone. */
  readonly dir?: string | null;
}

export interface DraftRequest {
  readonly model: string;
  /** The operator's own line: "forest by a stream". The one thing only they know. */
  readonly brief: string;
  readonly room: { readonly name: string; readonly sector: string; readonly zone: string };
  /** Rooms next door, with their prose. The context that makes a corner of a hall specific. */
  readonly nearby: readonly ProseSample[];
  /** Real descriptions from the same zone, verbatim. The style, shown. */
  readonly samples: readonly ProseSample[];
}

/**
 * Asks Ollama what it has.
 *
 * Returns an empty list rather than throwing when Ollama is not running, because "not installed" is
 * an ordinary state of this machine and the panel should say so calmly rather than show an error
 * where a dropdown belongs. A genuine failure — Ollama up but answering nonsense — comes back the
 * same way, which is the one thing lost by that choice and is worth it.
 */
export async function listModels(fetchImpl: typeof fetch = fetch): Promise<readonly OllamaModel[]> {
  try {
    const response = await fetchImpl(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      models?: readonly { name?: unknown; size?: unknown; details?: { parameter_size?: unknown } }[];
    };
    return (body.models ?? [])
      .filter((model): model is { name: string; size: number; details?: { parameter_size?: string } } =>
        typeof model.name === 'string',
      )
      .map((model) => ({
        name: model.name,
        size: typeof model.size === 'number' ? model.size : 0,
        parameters: typeof model.details?.parameter_size === 'string' ? model.details.parameter_size : null,
      }));
  } catch {
    return [];
  }
}

/** Whether Ollama answers at all, for the panel's "is it there" line. */
export async function ollamaReachable(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Builds the prompt. **Pure**, so the thing hardest to get right is the thing easiest to test.
 *
 * The order is deliberate: rules first, then the samples that demonstrate them, then the neighbours
 * that constrain the content, then the brief last. A model's attention is at both ends of a prompt
 * and the brief is the one instruction that must not be diluted, so it goes where it will be read.
 *
 * **Colour codes are stripped from the samples and forbidden in the output.** The world's prose does
 * carry `&+y`, and it would be lovely to have the model reproduce it — but a malformed code is not a
 * cosmetic failure, it is a literal `&+` in the middle of a sentence in the game. The palette is six
 * inches away in the editor, and colouring a draft by hand takes seconds. Reliability wins.
 */
export function buildPrompt(request: DraftRequest): string {
  const lines: string[] = [];

  lines.push('You are writing a room description for a text MUD set in the Forgotten Realms.');
  // **Only when there are examples to match.** The Stag Forest has prose for 0 of 98 rooms, so the
  // first room written in a zone has nothing to show the model — and "match the EXAMPLES exactly"
  // with no examples beneath it is worse than saying nothing: it points at a thing that is not there
  // and the model invents what it must have said.
  if (request.samples.length > 0) {
    lines.push(
      'Match the voice, rhythm and level of detail of the EXAMPLES exactly. They are from the same',
      'part of the world and they are the specification for the style.',
    );
  } else {
    lines.push(
      'Write plain, concrete, unhurried prose in the style of a classic Diku MUD: physical detail,',
      'no atmosphere for its own sake, no adjectives doing the work of nouns.',
    );
  }
  lines.push(
    '',
    'Rules:',
    `- ${STYLE.minWords} to ${STYLE.maxWords} words, about ${STYLE.sentences} sentences. One paragraph.`,
    '- Third person, present tense. Describe the place; do not address the reader. Never write "you".',
    // Measured: 16 of 216 mention exits, and the game already prints "Exits: east." on its own line.
    '- Do not list or mention exits, directions or doors. The game prints those separately.',
    // **Both of these were learned from drafts.** Told only "describe the place", a model ends every
    // room with "a narrow path winds deeper into the wood" — which is an exit wearing a coat — and
    // fills the middle with "secrets in a language long forgotten", which is atmosphere standing in
    // for detail. The house style is physical: things that are there, in the sizes and colours they
    // are. Stated as positives rather than as a list of banned words, which a model routes around.
    '- Describe only this room. Do not say where a path, trail, stream or opening leads.',
    '- Every sentence must name something physically present that a person standing here could see,',
    '  hear, smell or touch. Mood comes from the detail, not from words about mood.',
    '- No claims about history, magic, memory or meaning unless something visible shows it.',
    '- Do not name or place any creature, person or item. Those are placed by the world, not the prose.',
    '- Plain text only. No markup, no colour codes, no quotation marks around the whole thing.',
    '- Output the description and nothing else. No preamble, no title, no commentary.',
    '',
  );

  if (request.samples.length > 0) {
    lines.push('EXAMPLES — real rooms from this same zone:', '');
    for (const sample of request.samples) {
      lines.push(`[${sample.name}]`, stripCodes(sample.description), '');
    }
  }

  if (request.nearby.length > 0) {
    lines.push(
      'ADJACENT ROOMS — what stands next to the room you are writing. Stay consistent with these:',
      '',
    );
    for (const near of request.nearby) {
      lines.push(`[${near.dir ? `${near.dir}: ` : ''}${near.name}]`, stripCodes(near.description), '');
    }
  }

  lines.push(
    'NOW WRITE THIS ROOM.',
    `Zone: ${request.room.zone}`,
    `Room name: ${request.room.name}`,
    `Terrain: ${request.room.sector}`,
    `The builder's brief: ${request.brief}`,
    '',
    'Write only the description.',
  );

  return lines.join('\n');
}

/** The MUD's colour notation, out of the samples. Same pattern as `shared/src/colour.ts`. */
function stripCodes(text: string): string {
  return text.replace(/&(?:[nN]|[+-][A-Za-z]|=[A-Za-z]{2})/g, '').replace(/[ \t]+/g, ' ').trim();
}

export interface DraftResult {
  readonly ok: true;
  readonly description: string;
  readonly model: string;
  readonly ms: number;
  /** Rules the first draft broke, when a retry was needed. Empty on a clean first answer. */
  readonly retriedFor: readonly string[];
}

/**
 * Rules a draft broke that a person would have to fix by hand.
 *
 * Only the ones that are **mechanically decidable and always wrong** — a model can be told six times
 * not to write "you" and still write it, and across a 25-room batch that is 25 hand-edits. Vaguer
 * failings ("too purple") are left to the reader, because a regex that judged prose would be worse
 * than the prose.
 */
export function violations(text: string): readonly string[] {
  const broken: string[] = [];
  // Measured: 1 of 216 shipped descriptions uses the second person. It is the rule models break most.
  if (/\b(you|your|yourself)\b/i.test(text)) broken.push('addresses the reader as "you"');
  // "Exits: north." or "To the east lies…" — the game prints exits on their own line already.
  if (/\bexits?\s*:/i.test(text) || /\bto the (north|south|east|west)\b/i.test(text)) {
    broken.push('mentions exits or directions');
  }
  return broken;
}

export interface DraftFailure {
  readonly ok: false;
  readonly error: string;
}

/**
 * Generates one description.
 *
 * `stream: false` because there is nothing to stream to — the draft appears in a text box when it is
 * finished, and a partial description is not useful to read. Temperature is left to the model's own
 * default rather than pinned: this is prose, the operator can press the button again, and a number
 * chosen here would be a guess applied to nine models with different scales.
 */
export async function draftDescription(
  request: DraftRequest,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<DraftResult | DraftFailure> {
  const started = now();
  const first = await generateOnce(request, fetchImpl);
  if (!first.ok) return first;

  const broken = violations(first.text);
  if (broken.length === 0) return { ok: true, description: first.text, model: request.model, ms: now() - started, retriedFor: [] };

  // **One retry, with the failure named.** Models break the "you" rule about one draft in three, and
  // in a 25-room batch that is eight hand-edits. Telling it what it did wrong works far better than
  // asking again identically, and one retry is the whole budget — a model that breaks the rule twice
  // is telling you the draft is worth reading before keeping, which is the default anyway.
  const scolded: DraftRequest = {
    ...request,
    brief: `${request.brief}\n\nYour previous attempt was rejected because it ${broken.join(' and ')}. Do not do that.`,
  };
  const second = await generateOnce(scolded, fetchImpl);
  if (!second.ok) return second;
  return { ok: true, description: second.text, model: request.model, ms: now() - started, retriedFor: broken };
}

/** One call to the model, with the failure modes an operator needs told apart. */
async function generateOnce(
  request: DraftRequest,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; text: string } | DraftFailure> {
  let response: Response;
  try {
    response = await fetchImpl(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: request.model, prompt: buildPrompt(request), stream: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const message = (err as Error).name === 'TimeoutError'
      ? `${request.model} did not answer within ${TIMEOUT_MS / 1000}s — a large model on a cold start can take a while; try again or pick a smaller one`
      : `could not reach Ollama at ${OLLAMA_URL}: ${(err as Error).message}`;
    return { ok: false, error: message };
  }

  if (!response.ok) {
    // Ollama's own message is far more useful than a status code — "model not found" is the common
    // one, and it names the model — so it is passed through rather than replaced.
    const detail = await response.text().catch(() => '');
    return { ok: false, error: `Ollama refused (${response.status}): ${detail.slice(0, 300)}` };
  }

  let body: { response?: unknown };
  try {
    body = (await response.json()) as { response?: unknown };
  } catch {
    return { ok: false, error: 'Ollama returned something that was not JSON' };
  }
  if (typeof body.response !== 'string' || !body.response.trim()) {
    return { ok: false, error: `${request.model} returned nothing` };
  }

  return { ok: true, text: tidy(body.response) };
}

/**
 * Cleans a draft into the shape a room description has.
 *
 * Every one of these handles something models actually do rather than something they might: a
 * conversational opener before the prose, the whole answer wrapped in quotes, a markdown heading, and
 * hard-wrapped lines that would arrive in the log as a ragged double-wrap. The alternative to fixing
 * them here is fixing them by hand on every single draft.
 */
export function tidy(raw: string): string {
  let text = raw.trim();

  // A leading line like "Here is the description:" or "**A Darkened Stairwell**".
  text = text.replace(/^(?:here(?:'s| is)[^\n]*|sure[^\n]*|\*\*[^\n]*\*\*|#{1,6}[^\n]*)\n+/i, '');
  // The whole thing in quotes, which several models do when told to output only one thing.
  const quoted = /^"([\s\S]+)"$/.exec(text.trim());
  if (quoted?.[1]) text = quoted[1];
  // Markdown emphasis, which is meaningless in the log and would print as asterisks.
  text = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])/g, '$1');
  // **Typographic punctuation, down to ASCII.** Measured across the 315 real descriptions in the two
  // populated zones: 110 straight quotes, and *zero* curly quotes or en/em dashes. The world is ASCII
  // and a model that writes `IceCrag’s` has broken the house style in a way nobody would spot until a
  // font somewhere rendered it differently. This is style-matching, not sanitising.
  text = text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
  // Hard wrapping, undone the same way `worldgen`'s `cleanDescription` undoes Diku's: paragraph
  // breaks are kept, line breaks inside a paragraph were a decision for an 80-column terminal.
  text = text
    .split(/\n\s*\n/)
    .map((para) => para.split('\n').map((line) => line.trim()).join(' ').trim())
    .filter(Boolean)
    .join('\n\n');

  return text.replace(/[ \t]{2,}/g, ' ').trim();
}
