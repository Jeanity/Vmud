/**
 * **Generated art for what a creature *is*** — bodies, head shapes and tails.
 *
 * `artgen.ts` indexes what a character *wears* and says in its own docblock that it deliberately
 * skips bodies, hair, wings and tails because *"those are what a character is, not what a character
 * is wearing, and they belong to whatever eventually replaces `SPRITE_LAYERS`."* **This is that
 * thing.** Keeping it a separate generator rather than a flag on the old one keeps that boundary
 * honest: an item picker must never be able to offer somebody a wolf's head as a hat.
 *
 * ## Why this exists at all
 *
 * Measured 2026-08-11: **all 1,503 mob templates in the loaded world draw `human`.** Not because the
 * data is thin — twelve distinct Duris race codes are harvested and present — but because
 * `SPRITE_LAYERS` in the client has exactly two entries and `HUMANOID_RACES` maps every code to
 * `'human'`. The art to fix it was already on disk and unindexed: ULPC ships **twenty head shapes**
 * (wolf, rabbit, rat, mouse, pig, sheep, boarman, minotaur, goblin, orc, troll, lizard, alien,
 * skeleton, zombie, vampire, frankenstein, jack, wartotaur, human), eight bodies, and four tails.
 *
 * ## The geometry filter is the same one, and for the same reason
 *
 * A sheet counts only if its `walk.png` is **576x256** — nine columns by four rows of 64, LPC's walk
 * cycle and the exact shape `characterLayers` draws. Everything here was checked before the file was
 * written: every head shape's `walk.png` is 576x256, so they compose with the existing bodies with
 * no rig work at all. Anything that does not measure up is skipped and counted rather than staged,
 * because an index listing art the renderer cannot draw is a picker full of magenta boxes.
 *
 * ## What this cannot give you
 *
 * **Four legs.** Every one of these is LPC's humanoid rig, so a `wolf` head on a `muscular` body is
 * a worg — a wolf that walks upright — and not a wolf. True quadrupeds are their own sheets with
 * their own frame layout (`CharlesGabriel`'s bat and snake are the shape of that), and they are a
 * separate job. Stated here because "we have a wolf head" reads like "we have a wolf" and does not
 * survive contact with the owner looking at it.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const PACK = process.env['GAME_LPC_PACK'] ?? join(REPO_ROOT, 'assets', 'ulpc');
const SHEETS = join(PACK, 'spritesheets');
const STAGED = join(REPO_ROOT, 'packages', 'client', 'public', 'lpc');

/** LPC's walk cycle: nine columns by four rows of 64. The one shape the renderer can draw. */
const WALK_WIDTH = 576;
const WALK_HEIGHT = 256;

/**
 * The action poses staged beside a walk cycle, when the pack has them.
 *
 * Same list and same suffixes `artgen` uses, so a creature body animates through exactly the
 * machinery a worn item already does. A body missing one simply does not get it — `child` has no
 * `shoot`, and a kobold that cannot draw a bow is better than a build that fails over it.
 */
const ACTIONS = ['hurt', 'idle', 'shoot', 'slash', 'spellcast', 'thrust'] as const;

export interface CreatureLayer {
  /** Texture key and staged filename. What `SPRITE_LAYERS` names. */
  readonly id: string;
  /** `body`, `head` or `tail` — which slot of a creature this fills. */
  readonly part: 'body' | 'head' | 'tail';
  /** The pack's own word: `wolf`, `muscular`, `lizard`. */
  readonly shape: string;
  /** The pack's variant beneath the shape: `male`, `adult`, `child`. */
  readonly variant: string;
  /** Which action poses were found beside the walk cycle. */
  readonly actions: readonly string[];
}

/** PNG header read directly — the whole pack is PNG and this avoids a decode per file. */
function pngSize(path: string): { width: number; height: number } | undefined {
  try {
    const head = readFileSync(path).subarray(0, 24);
    if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return undefined;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return undefined;
  }
}

function isWalkSheet(path: string): boolean {
  const size = pngSize(path);
  return size?.width === WALK_WIDTH && size.height === WALK_HEIGHT;
}

/**
 * Whether an *action* sheet is drawable — `artgen`'s own `actionGeometry` rule, and it has to be a
 * different test from the walk cycle's.
 *
 * A walk is always 576x256. An action is not: a slash is eight columns, a thrust is eight at a
 * larger frame, a spellcast is seven. Requiring 576x256 of them rejected **every action pose in the
 * pack** on the first run — 52 layers staged and not one of them could swing. Four rows, a frame of
 * 64/128/192, and a whole number of columns between four and sixteen is what the renderer reads.
 */
function isActionSheet(path: string): boolean {
  const size = pngSize(path);
  if (!size || size.height % 4 !== 0) return false;
  const frame = size.height / 4;
  if (frame !== 64 && frame !== 128 && frame !== 192) return false;
  if (size.width % frame !== 0) return false;
  const columns = size.width / frame;
  return columns >= 4 && columns <= 16;
}

function directories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
}

/** A part's directories are `<shape>/<variant>/walk.png`, with the variant sometimes absent. */
function layersUnder(
  root: string,
  part: CreatureLayer['part'],
  id: (shape: string, variant: string) => string,
): { layers: CreatureLayer[]; staged: string[][]; skipped: number } {
  const layers: CreatureLayer[] = [];
  const staged: string[][] = [];
  let skipped = 0;

  for (const shape of directories(root)) {
    const shapeDir = join(root, shape);
    // Three layouts occur in the pack: `<shape>/walk.png`, `<shape>/<variant>/walk.png`, and for
    // tails `<shape>/<variant>/{bg,fg}/walk.png` — a tail is drawn in two halves, one behind the
    // body and one in front, which is how it reads as wrapping round a leg. Each half is a layer.
    const variants = existsSync(join(shapeDir, 'walk.png'))
      ? ['']
      : directories(shapeDir).flatMap((v) => {
          const inner = join(shapeDir, v);
          if (existsSync(join(inner, 'walk.png'))) return [v];
          const halves = directories(inner);
          const found = halves.filter((half) => existsSync(join(inner, half, 'walk.png')));
          // **A fourth layout exists and is deliberately not handled here.** The wolf, cat and
          // fluffy tails ship as `<shape>/<variant>/<half>/<pose>/<colour>.png` — per-colour files
          // instead of a runtime palette, so one tail is fifteen sheets and indexing them the way
          // this pass indexes everything else would put a hundred and eighty near-identical ids in
          // the catalogue. It wants a colour-aware pass of its own. Counted rather than dropped in
          // silence, because a generator that says "0 skipped" while quietly losing three of four
          // tails is lying to whoever reads its output.
          if (found.length === 0 && halves.length > 0) skipped += halves.length;
          return found.map((half) => join(v, half));
        });
    for (const variant of variants) {
      const dir = variant ? join(shapeDir, variant) : shapeDir;
      const walk = join(dir, 'walk.png');
      if (!existsSync(walk) || !isWalkSheet(walk)) {
        skipped++;
        continue;
      }
      // `join` gives a platform separator, so a tail's `adult/fg` arrives as `adult\fg` on Windows.
      // Flattened to a hyphen so the texture key is the same string on every machine.
      const key = id(shape, (variant || 'default').split(/[\\/]/).join('-'));
      const actions: string[] = [];
      const copies: string[][] = [[walk, `${key}.png`]];
      for (const action of ACTIONS) {
        const path = join(dir, `${action}.png`);
        if (!existsSync(path) || !isActionSheet(path)) continue;
        actions.push(action);
        copies.push([path, `${key}-${action}.png`]);
      }
      layers.push({ id: key, part, shape, variant: variant || 'default', actions });
      staged.push(...copies);
    }
  }
  return { layers, staged, skipped };
}

export interface CreaturegenResult {
  readonly layers: readonly CreatureLayer[];
  readonly files: number;
  readonly skipped: number;
}

export function buildCreatureIndex(): CreaturegenResult {
  if (!existsSync(SHEETS)) {
    throw new Error(
      `no ULPC spritesheets at ${SHEETS}. The pack is git-ignored and ~1.5 GB; point GAME_LPC_PACK ` +
        `at an existing copy rather than cloning it per worktree (CLAUDE.md, the art-pack note).`,
    );
  }

  const passes = [
    // Bodies keep the pack's own word and no shape prefix: `body-muscular`, `body-skeleton`. The
    // long-standing `body-human-male` is left exactly where it is — every player draws it.
    layersUnder(join(SHEETS, 'body', 'bodies'), 'body', (shape, variant) =>
      variant === 'default' ? `body-${shape}` : `body-${shape}-${variant}`),
    // `head-` is already headwear's prefix (`head-cap-leather`), so a shape says so: a hat and a
    // face must never collide in one flat texture namespace.
    layersUnder(join(SHEETS, 'head', 'heads'), 'head', (shape, variant) => `head-shape-${shape}-${variant}`),
    layersUnder(join(SHEETS, 'body', 'tail'), 'tail', (shape, variant) => `tail-${shape}-${variant}`),
  ];

  mkdirSync(STAGED, { recursive: true });
  let files = 0;
  for (const pass of passes) {
    for (const [from, to] of pass.staged) {
      copyFileSync(from!, join(STAGED, to!));
      files++;
    }
  }

  const layers = passes.flatMap((p) => p.layers).sort((a, b) => a.id.localeCompare(b.id));
  return { layers, files, skipped: passes.reduce((sum, p) => sum + p.skipped, 0) };
}

function writeIndex(result: CreaturegenResult): void {
  const rows = result.layers
    .map(
      (l) =>
        `  { id: ${JSON.stringify(l.id)}, part: ${JSON.stringify(l.part)}, ` +
        `shape: ${JSON.stringify(l.shape)}, variant: ${JSON.stringify(l.variant)}, ` +
        `actions: ${JSON.stringify(l.actions)} },`,
    )
    .join('\n');

  const body = `/**
 * **Generated by \`npm run creaturegen\` — do not edit.**
 *
 * What a creature is made of: bodies, head shapes and tails indexed from \`assets/ulpc\` and staged
 * into \`packages/client/public/lpc/<id>.png\`, so the id *is* the texture key. Every entry resolved
 * to a real 576x256 walk sheet, which is the only geometry the renderer can draw.
 *
 * Separate from \`lpc-art.ts\` on purpose — that is what a character *wears*, this is what one *is*,
 * and an item picker must never be able to offer a wolf's head as a hat.
 *
 * Attribution is \`ATTRIBUTION-generated.md\`, beside the staged files. CC-BY-SA 3.0 / GPL / OGA-BY,
 * and attribution is mandatory — see \`CLAUDE.md\`.
 */

/** One indexed creature layer. */
export interface CreatureLayer {
  readonly id: string;
  readonly part: 'body' | 'head' | 'tail';
  /** The pack's own word: \`wolf\`, \`muscular\`, \`lizard\`. */
  readonly shape: string;
  /** The pack's variant beneath it: \`male\`, \`adult\`, \`child\`. */
  readonly variant: string;
  /** Action poses staged beside the walk cycle. */
  readonly actions: readonly string[];
}

export const CREATURE_LAYERS: readonly CreatureLayer[] = [
${rows}
];

export const CREATURE_LAYER_BY_ID: ReadonlyMap<string, CreatureLayer> = new Map(
  CREATURE_LAYERS.map((l) => [l.id, l]),
);

/** Every distinct head shape the pack gave us — the vocabulary a matcher may choose from. */
export const HEAD_SHAPES: readonly string[] = [
  ...new Set(CREATURE_LAYERS.filter((l) => l.part === 'head').map((l) => l.shape)),
].sort();

/** Every distinct body. */
export const BODY_SHAPES: readonly string[] = [
  ...new Set(CREATURE_LAYERS.filter((l) => l.part === 'body').map((l) => l.shape)),
].sort();
`;

  writeFileSync(join(REPO_ROOT, 'packages', 'shared', 'src', 'creature-art.ts'), body, 'utf8');
}

/**
 * Credits for the staged layers, read from the pack's own definitions.
 *
 * **Mandatory, not decorative.** These sheets are CC-BY-SA 3.0 / GPL / OGA-BY and `CLAUDE.md` is
 * explicit that attribution ships with the art. Generated for the same reason `artgen`'s is: a
 * hand-kept credit list goes stale the first time a sheet is added, and the failure mode of a stale
 * one is a licence breach rather than a typo.
 *
 * ULPC keys each credit block by the **directory it covers** (`body/bodies/male`), which is exactly
 * what this generator stages from — so a layer finds its authors by matching the longest `file`
 * prefix, and one that finds none is reported rather than shipped uncredited.
 */
function writeCreatureAttribution(layers: readonly CreatureLayer[]): { credited: number; uncredited: string[] } {
  interface Credit { readonly file: string; readonly authors?: string[]; readonly licenses?: string[] }
  const credits: Credit[] = [];
  // **Recursive, and that was not optional.** The body credits sit in `sheet_definitions/body/*.json`
  // but the head ones are filed by family — `head/heads/beast/wolf.json`, `head/heads/farm/pig.json`
  // — so a flat read of the top level found six of fifty-six and reported fifty uncredited. Fifty
  // uncredited sheets is a licence breach with a progress bar, which is why the count is printed.
  const collect = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        collect(path);
        continue;
      }
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { credits?: Credit[] };
        for (const credit of parsed.credits ?? []) if (credit.file) credits.push(credit);
      } catch {
        // A definition we cannot parse is one we cannot credit; the uncredited list below says so.
      }
    }
  };
  for (const group of ['body', 'head']) collect(join(PACK, 'sheet_definitions', group));
  // Longest prefix wins: `body/bodies/male` must beat `body/bodies` when both are present.
  const byLength = [...credits].sort((a, b) => b.file.length - a.file.length);

  const rows: string[] = [];
  const byAuthor = new Map<string, number>();
  const licences = new Set<string>();
  const uncredited: string[] = [];
  for (const layer of layers) {
    const root = layer.part === 'head' ? 'head/heads' : layer.part === 'tail' ? 'body/tail' : 'body/bodies';
    // Credits are filed per shape *or* per shape-and-variant (`head/heads/human/male`), so probe the
    // specific path and let the longest matching prefix win.
    const probe = `${root}/${layer.shape}/${layer.variant.split('-')[0]}`;
    const hit = byLength.find((c) => probe.startsWith(c.file));
    if (!hit?.authors?.length) {
      uncredited.push(layer.id);
      continue;
    }
    for (const a of hit.authors) byAuthor.set(a, (byAuthor.get(a) ?? 0) + 1);
    for (const l of hit.licenses ?? []) licences.add(l);
    rows.push(`| \`${layer.id}\` | ${layer.part} | ${hit.authors.join(', ')} | ${(hit.licenses ?? []).join(', ')} |`);
  }

  const lines = [
    '# Attribution — creature layers, generated by `npm run creaturegen`',
    '',
    'Bodies, head shapes and tails staged from the',
    '[Universal LPC Spritesheet Generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator).',
    "Credits are reproduced from that project's own `sheet_definitions`, keyed by the directory each",
    'block covers. Companion to `ATTRIBUTION-generated.md`, which credits what a character *wears*.',
    '',
    `**${rows.length} layers credited.** Licences in force: ${[...licences].sort().join(', ') || 'none read'}.`,
    ...(uncredited.length > 0
      ? ['', `**${uncredited.length} layer(s) matched no credit block** and are listed at the end — do not ship these until they are credited.`]
      : []),
    '',
    '## Authors',
    '',
    ...[...byAuthor.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a, n]) => `- ${a} (${n} layers)`),
    '',
    '## Per layer',
    '',
    '| id | part | authors | licences |',
    '| --- | --- | --- | --- |',
    ...rows,
    ...(uncredited.length > 0 ? ['', '## Uncredited', '', ...uncredited.map((id) => `- \`${id}\``)] : []),
    '',
  ];
  writeFileSync(join(STAGED, 'ATTRIBUTION-creatures.md'), `${lines.join('\n')}\n`, 'utf8');
  return { credited: rows.length, uncredited };
}

if (import.meta.filename === process.argv[1]) {
  const result = buildCreatureIndex();
  writeIndex(result);
  const credit = writeCreatureAttribution(result.layers);
  const byPart = (part: string): number => result.layers.filter((l) => l.part === part).length;
  console.log(
    `[creaturegen] ${result.layers.length} layer(s) indexed — ` +
      `${byPart('body')} bodies, ${byPart('head')} head shapes, ${byPart('tail')} tails; ` +
      `${result.files} file(s) staged, ${result.skipped} directory(ies) skipped for geometry; ` +
      `${credit.credited} credited` +
      (credit.uncredited.length > 0 ? `, ${credit.uncredited.length} UNCREDITED` : ''),
  );
}
