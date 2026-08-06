/**
 * The LPC art index — **A7a**, and the offline half of "assign a graphic to an item".
 *
 * `assets/ulpc` is the Universal LPC Spritesheet Generator: 657 sheet definitions and about 1.5 GB of
 * art, git-ignored because it is upstream's and enormous. This pass reads its **definitions** — which
 * are machine-readable and carry everything we need, including the credits CC-BY-SA obliges us to
 * reproduce — and emits a small committed index plus the handful of sheets we actually stage.
 *
 * ## Why it probes instead of trusting the path
 *
 * A definition names a *directory*, and what is inside it is not consistent. Measured across the pack:
 *
 * - `weapon/blunt/club/` holds `club.png` directly — one oversize sheet, no walk cycle.
 * - `weapon/sword/dagger/` holds `walk/dagger.png` — a walk cycle, per variant.
 * - `feet/boots/basic/male/` holds `walk.png` — a walk cycle, one file, because its colours are
 *   *palette swaps applied at runtime* rather than shipped variants.
 *
 * So the resolver tries the two real shapes and **verifies the pixels**: a sheet counts only if it is
 * 576×256, which is nine columns by four rows of 64 — LPC's walk cycle and the exact geometry
 * `characterLayers` already draws every body from. Anything else is skipped rather than indexed.
 *
 * **That filter is the point, not a limitation.** An index listing art the renderer cannot draw is a
 * picker full of choices that produce a magenta box, and the operator has no way to tell which is
 * which until they try. What is here can be worn.
 *
 * ## What it deliberately does not do
 *
 * It does not index bodies, hair, beards, expressions, wounds, wings or tails. Those are what a
 * *character* is, not what a character is *wearing*, and they belong to whatever eventually replaces
 * `SPRITE_LAYERS` — not to an item editor.
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Where the upstream pack lives. **`assets/` is git-ignored, so a worktree does not have one.**
 *
 * The same trap `data/world` sets and for the same reason: a fresh worktree looks complete and is
 * missing exactly the large, unversioned directories. `GAME_LPC_PACK` points at the main checkout's
 * copy rather than anybody duplicating 1.5 GB per branch, and the failure below names it, because
 * "ENOENT: scandir sheet_definitions" tells nobody what to do next.
 */
const PACK = process.env.GAME_LPC_PACK
  ? resolve(process.env.GAME_LPC_PACK)
  : join(REPO_ROOT, 'assets', 'ulpc');
const DEFINITIONS = join(PACK, 'sheet_definitions');
const SPRITESHEETS = join(PACK, 'spritesheets');
const PALETTES = join(PACK, 'palette_definitions');
const STAGED = join(REPO_ROOT, 'packages', 'client', 'public', 'lpc');
const INDEX_FILE = join(REPO_ROOT, 'packages', 'shared', 'src', 'lpc-art.ts');
const ATTRIBUTION = join(STAGED, 'ATTRIBUTION-generated.md');

/** LPC's walk sheet: nine frames across, four facings down, at 64px. What the renderer already draws. */
const WALK_WIDTH = 576;
const WALK_HEIGHT = 256;

/**
 * ULPC's `type_name` mapped to the slot we would wear it in.
 *
 * A *suggestion*, not a rule — it lets the picker show boots when the operator is editing a pair of
 * boots, and nothing stops them putting a hat sheet on a sword if that is what they want. The mapping
 * is one-way and lossy on purpose: ULPC distinguishes `jacket` from `clothes` from `vest`, and all
 * three go on the chest.
 */
const SLOT_FOR_TYPE: Readonly<Record<string, string>> = {
  weapon: 'mainHand',
  weapon_magic_crystal: 'mainHand',
  shield: 'offHand',
  shield_trim: 'offHand',
  shield_pattern: 'offHand',
  shield_paint: 'offHand',
  hat: 'head',
  hat_trim: 'head',
  hat_overlay: 'head',
  headcover: 'head',
  bandana: 'head',
  visor: 'head',
  clothes: 'chest',
  jacket: 'chest',
  jacket_trim: 'chest',
  vest: 'chest',
  dress: 'chest',
  armour: 'chest',
  chainmail: 'chest',
  overalls: 'chest',
  apron: 'chest',
  bandages: 'chest',
  sleeves: 'arms',
  arms: 'arms',
  bracers: 'arms',
  shoulders: 'arms',
  bauldron: 'arms',
  wrists: 'wrist1',
  gloves: 'hands',
  legs: 'legs',
  shoes: 'feet',
  shoes_toe: 'feet',
  socks: 'feet',
  belt: 'waist',
  sash: 'waist',
  buckles: 'waist',
  cape: 'about',
  cape_trim: 'about',
  backpack: 'back',
  cargo: 'back',
  quiver: 'quiver',
  neck: 'neck',
  necklace: 'neck',
  earrings: 'ear1',
  nose: 'nose',
  ring: 'ring1',
  charm: 'neck',
  ammo: 'quiver',
};

interface RawLayer {
  readonly zPos?: number;
  readonly male?: string;
  readonly female?: string;
  readonly muscular?: string;
}

interface RawDefinition {
  readonly name?: string;
  readonly type_name?: string;
  readonly variants?: readonly string[];
  /**
   * **A7e** — what this sheet may be recoloured into. `{ material, base?, palettes: [...] }`.
   *
   * Note the field is `recolors` and not `palettes`; `palettes` is the array *inside* it, and an earlier
   * count of “424 with palettes” was counting this. **424 of 769 definitions carry it**, confirmed.
   *
   * A palette entry is `[family.]version` — a bare `"ulpc"` resolves against `material`, while
   * `"cloth.ulpc"` and `"all.lpcr"` name a family outright, so one sheet can offer ramps from more than
   * one family. Measured 2026-08-06: **all 1,048 references across the pack resolve to a file that
   * exists**, which retires the roadmap's worry that an art could declare recolours resolving to nothing.
   */
  readonly recolors?: {
    readonly material?: string;
    /** Overrides the family's own base ramp. `arms_hands_ring_stud` is `cloth` but declares `teal`. */
    readonly base?: string;
    readonly palettes?: readonly string[];
  };
  readonly credits?: readonly {
    readonly authors?: readonly string[];
    readonly licenses?: readonly string[];
    readonly urls?: readonly string[];
    readonly notes?: string;
  }[];
  /**
   * `layer_1`, `layer_2`, … — **any number of them, and that was the bug.**
   *
   * This used to name exactly two, which quietly meant "we only ever look at the first". A quarter of
   * the pack — 168 of 657 definitions — has more, and the extras are not decoration: they are the
   * halves of a thing that go *behind* the body. `weapon_sword_rapier` keeps the blade in `layer_1`
   * at z 140 and the same blade drawn behind the wielder in `layer_2` at z 9, which is what a sword
   * looks like when its owner has their back to you. `cape_solid` keeps the shoulders at z 85 and the
   * cloak that actually hangs down at z 5.
   *
   * An index signature rather than a longer list of named fields, so the day a five-layer definition
   * lands nothing has to be edited to see it.
   */
  readonly [layer: `layer_${number}`]: RawLayer | undefined;
}

/** One indexed piece of art: a stable id, where it came from, and what it may be worn as. */
export interface ArtEntry {
  readonly id: string;
  readonly name: string;
  /** ULPC's own `type_name`, kept raw — the source's vocabulary, same rule as `DURIS_ITEM`. */
  readonly kind: string;
  /** The slot this would ordinarily go in, for filtering a picker. Not enforced anywhere. */
  readonly slot?: string;
  /**
   * **A7e** — what this sheet may be recoloured into, or absent if it may not be.
   *
   * Declared here as well as in the emitted index because this file writes that one: the two are the
   * same shape by construction, and a field added to one and not the other is a type error rather than
   * a silent gap — the same rule `SKILL_IDS` and `SKILLS` keep.
   */
  readonly recolours?: { readonly material: string; readonly base: string; readonly ramps: readonly string[] };
  /**
   * The sheet a *thumbnail* should use, and the front-most layer of the art.
   *
   * A convenience mirror of the highest-z entry in {@link layers}, kept because a picker needs one
   * picture and "the front of the thing" is the right one to show. **The renderer must use `layers`**:
   * this alone is a cloak's shoulders without its cloak.
   */
  readonly sheet: string;
  /** The front-most layer's `zPos`. Mirrors {@link layers}, same rule as {@link sheet}. */
  readonly z: number;
  /**
   * Every staged layer of this art, **in draw order** (lowest z first).
   *
   * Usually one. For 168 of the pack's 657 definitions it is more, and those are the ones that were
   * broken until 2026-08-05: a weapon has a copy of itself drawn *behind* the body for the facings
   * where its owner's back is turned, and a cape has the whole hanging cloak on a layer beneath the
   * character. Staging only the first meant a sword that vanished when you walked north and a cloak
   * that was nothing but a collar.
   *
   * The z values are ULPC's own and already say where each layer belongs in the body's stack, so a
   * renderer that sorts by z needs no rule about which layer is which — it just gets more of them.
   */
  readonly layers: readonly { readonly sheet: string; readonly z: number }[];
  readonly authors: readonly string[];
  readonly licences: readonly string[];
}

const png = (path: string): readonly [number, number] | undefined => {
  try {
    const buffer = readFileSync(path);
    // The IHDR width and height sit at fixed offsets in every PNG. Cheaper than decoding, and this
    // runs over thousands of candidates.
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  } catch {
    return undefined;
  }
};

const isWalkSheet = (path: string): boolean => {
  const size = png(path);
  return size !== undefined && size[0] === WALK_WIDTH && size[1] === WALK_HEIGHT;
};

/** Every `.json` under the definitions tree, skipping ULPC's own `meta_*` grouping files. */
function definitionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) definitionFiles(path, out);
    else if (entry.name.endsWith('.json') && !entry.name.startsWith('meta_')) out.push(path);
  }
  return out;
}

/**
 * The walk sheet for a definition, or nothing.
 *
 * Two shapes, in order, because that is what the pack actually contains — see the note at the top.
 * The variant, where there is one, is also what names the file, so it comes back with the path: two
 * variants of one definition are two entries in the index, not one entry with a hidden choice.
 */
function resolveWalk(base: string, variants: readonly string[]): { path: string; variant?: string } | undefined {
  const root = base.replace(/\/+$/, '');
  for (const variant of variants) {
    const path = join(SPRITESHEETS, root, 'walk', `${variant}.png`);
    if (isWalkSheet(path)) return { path, variant };
  }
  const plain = join(SPRITESHEETS, root, 'walk.png');
  if (isWalkSheet(plain)) return { path: plain };
  return undefined;
}

/** `a-b-c` from a definition's own filename, which is already unique and already descriptive. */
const idFrom = (file: string, variant?: string): string => {
  const base = file.split(/[\\/]/).pop()!.replace(/\.json$/, '').replace(/_/g, '-');
  return variant ? `${base}-${variant.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : base;
};

export interface ArtgenResult {
  readonly entries: readonly ArtEntry[];
  readonly considered: number;
  readonly skipped: number;
  /** Ids whose staged filename was already taken by art this generator did not put there. */
  readonly collisions: readonly string[];
}

/**
 * The ids the last run produced, read back off the generated module.
 *
 * **The whole point is knowing whose file is whose.** Sheets staged by hand in 15a —
 * `torso-chainmail`, `body-human-male` and the rest of the starter kit — live in the same directory
 * and the same namespace as generated ones, and the first run of this generator quietly overwrote the
 * chainmail the IceCrag sentry wears. An id in the previous index is ours to replace; an id that is
 * not is somebody else's work, and it is left alone and reported.
 */
function previouslyGenerated(): ReadonlySet<string> {
  try {
    const source = readFileSync(INDEX_FILE, 'utf8');
    return new Set([...source.matchAll(/\{ id: '([^']+)'/g)].map((m) => m[1]!));
  } catch {
    return new Set();
  }
}

/**
 * Every ramp the pack ships, by table — `cloth_ulpc`, `metal_ulpc`, `all_lpcr` and nine more.
 *
 * **Baked into the generated index rather than fetched**, which measurement 5 makes free: the whole set
 * is 215 ramps in 12 files, 28 KB of JSON before minification. A route to serve it would be a route to
 * keep working, an ordering problem at boot, and a failure mode where the picker loads and the colours do
 * not — for a payload smaller than one sprite sheet.
 */
export function readPalettes(): Record<string, Record<string, readonly string[]>> {
  const out: Record<string, Record<string, readonly string[]>> = {};
  let families: string[];
  try {
    families = readdirSync(PALETTES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const family of families) {
    for (const file of readdirSync(join(PALETTES, family))) {
      // `meta_<family>.json` is the family's own record — its label and, crucially, its **base** ramp.
      // Read separately by `readPaletteBases`; skipped here so it cannot be mistaken for a ramp table.
      if (file.startsWith('meta_') || !file.endsWith('.json')) continue;
      try {
        const table = JSON.parse(readFileSync(join(PALETTES, family, file), 'utf8')) as Record<string, unknown>;
        const ramps: Record<string, readonly string[]> = {};
        for (const [name, value] of Object.entries(table)) {
          if (!Array.isArray(value) || value.some((c) => typeof c !== 'string')) continue;
          ramps[name] = value as string[];
        }
        if (Object.keys(ramps).length > 0) out[file.replace(/\.json$/, '')] = ramps;
      } catch {
        // A malformed palette file is dropped rather than fatal, the posture every reader here takes.
      }
    }
  }
  return out;
}

/**
 * Each family's **base** ramp — the one its sheets are actually drawn in.
 *
 * This is the half of the recolour that cannot be guessed: cloth's is `white`, body's `light`, hair's
 * `orange`, wood's `maple`, metal's `steel`. Recolouring maps *these* six colours onto the target's,
 * index by index, so reading the wrong base recolours the wrong pixels and the sheet comes out muddy
 * rather than wrong-in-an-obvious-way.
 */
export function readPaletteBases(): Record<string, string> {
  const out: Record<string, string> = {};
  let families: string[];
  try {
    families = readdirSync(PALETTES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const family of families) {
    try {
      const meta = JSON.parse(readFileSync(join(PALETTES, family, `meta_${family}.json`), 'utf8')) as {
        base?: unknown;
      };
      if (typeof meta.base === 'string') out[family] = meta.base;
    } catch {
      // No metadata is a family with no declared base, which `recoloursOf` then declines to offer.
    }
  }
  return out;
}

/**
 * What one definition may be recoloured into, resolved against the ramp tables that actually exist.
 *
 * Three things are settled here rather than left to the panel. The **material** decides which family's
 * base the sheet is drawn in. The **base** comes from the definition first and the family second — the
 * measurement the roadmap's five did not have, and the one that would otherwise recolour
 * `arms_hands_ring_stud` from `white` when it is drawn in `teal`. And a palette reference is expanded to
 * every **named ramp inside it**, because `"cloth.ulpc"` is a table of 24 and a picker wants the 24.
 */
export function recoloursOf(
  raw: RawDefinition,
  tables: Readonly<Record<string, Record<string, readonly string[]>>>,
  bases: Readonly<Record<string, string>>,
): { material: string; base: string; ramps: string[] } | undefined {
  const material = raw.recolors?.material;
  if (!material) return undefined;
  const base = raw.recolors?.base ?? bases[material];
  if (!base) return undefined;

  const ramps: string[] = [];
  for (const reference of raw.recolors?.palettes ?? []) {
    const key = reference.includes('.') ? reference.replace('.', '_') : `${material}_${reference}`;
    const table = tables[key];
    if (!table) continue;
    for (const name of Object.keys(table)) {
      const ramp = `${key}.${name}`;
      if (!ramps.includes(ramp)) ramps.push(ramp);
    }
  }
  // A sheet whose every reference missed offers nothing, and the entry carries no `recolors` at all —
  // which is what lets the picker say *this one cannot be recoloured* from the index alone.
  return ramps.length > 0 ? { material, base, ramps } : undefined;
}

export function buildArtIndex(): ArtgenResult {
  try {
    readdirSync(DEFINITIONS);
  } catch {
    throw new Error(
      `No LPC pack at ${PACK}. It is git-ignored (1.5 GB), so a worktree will not have one — ` +
        `point GAME_LPC_PACK at the main checkout's copy, e.g. ` +
        `GAME_LPC_PACK=D:/MyGame/assets/ulpc npm run artgen`,
    );
  }
  const entries: ArtEntry[] = [];
  const seen = new Set<string>();
  // Read once for the whole run rather than per definition: 424 of them ask, and the answer is 28 KB
  // that does not change between files.
  const tables = readPalettes();
  const bases = readPaletteBases();
  const ours = previouslyGenerated();
  const collisions: string[] = [];
  let considered = 0;
  let skipped = 0;

  for (const file of definitionFiles(DEFINITIONS)) {
    let raw: RawDefinition;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as RawDefinition;
    } catch {
      continue;
    }
    const kind = raw.type_name;
    if (!kind || !(kind in SLOT_FOR_TYPE)) continue;
    considered++;

    // **Every layer, in the definition's own order**, not `layer_1` and a shrug. Each is resolved
    // independently and the ones with no walk sheet drop out — which is exactly how the attack
    // animations exclude themselves for free: `weapon/sword/rapier/attack_slash/` has a slash sheet
    // and no `walk.png`, so it never reaches the index and cannot be drawn on a walking character.
    // That leaves the two that matter: the blade in front at z 140 and the blade behind at z 9.
    const resolved: { layerKey: string; found: { path: string; variant?: string }; z: number }[] = [];
    for (const key of Object.keys(raw).filter((k): k is `layer_${number}` => /^layer_\d+$/.test(k))) {
      const layer = raw[key];
      const base = layer?.male ?? layer?.female ?? layer?.muscular;
      if (!base) continue;
      const found = resolveWalk(base, raw.variants ?? []);
      if (!found) continue;
      resolved.push({ layerKey: key, found, z: layer?.zPos ?? 50 });
    }
    if (resolved.length === 0) {
      skipped++;
      continue;
    }
    // Sorted by the number in the key, so `layer_1` is the id-bearing one however the JSON is ordered.
    resolved.sort((a, b) => Number(a.layerKey.slice(6)) - Number(b.layerKey.slice(6)));

    // The variant names the id, and it comes off the *first* layer: two variants of one definition are
    // two entries in the index, and every layer of one entry is the same variant by construction.
    const found = resolved[0]!.found;
    const id = idFrom(file, found.variant);
    if (seen.has(id)) continue;
    seen.add(id);

    // Somebody else's sheet already sits at this name. Reported and left alone rather than replaced —
    // and left *out of the index*, so nothing can be authored onto art this run does not own.
    const target = join(STAGED, `${id}.png`);
    if (!ours.has(id) && png(target) !== undefined) {
      collisions.push(id);
      continue;
    }

    const recolours = recoloursOf(raw, tables, bases);
    const authors = [...new Set((raw.credits ?? []).flatMap((c) => c.authors ?? []))].sort();
    const licences = [...new Set((raw.credits ?? []).flatMap((c) => c.licenses ?? []))].sort();

    // The first layer keeps the art id as its texture key, so **every already-authored `art` value
    // still names a real sheet** — this change adds layers under a body, it does not renumber one.
    // The rest take `<id>-l<n>`, which is traceable straight back to the definition's own key.
    mkdirSync(STAGED, { recursive: true });
    const layers = resolved.map((entry, index) => {
      const sheet = index === 0 ? id : `${id}-${entry.layerKey.replace('layer_', 'l')}`;
      // The sheet is staged under its key, so the client needs no path mapping at all — the string it
      // is handed *is* the texture key. One fewer table to drift.
      copyFileSync(entry.found.path, join(STAGED, `${sheet}.png`));
      return { sheet, z: entry.z };
    });
    // Draw order, lowest first — what a renderer stacking a body wants, and it means the client sorts
    // nothing that this has not already sorted.
    layers.sort((a, b) => a.z - b.z);
    const front = layers[layers.length - 1]!;

    entries.push({
      id,
      name: raw.name ?? id,
      kind,
      ...(SLOT_FOR_TYPE[kind] ? { slot: SLOT_FOR_TYPE[kind] } : {}),
      ...(recolours ? { recolours } : {}),
      sheet: front.sheet,
      z: front.z,
      layers,
      authors,
      licences,
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { entries, considered, skipped, collisions };
}

/** The generated module. A `.ts` const rather than JSON, so no import attributes and it typechecks. */
function writeIndex(entries: readonly ArtEntry[], palettes: Record<string, Record<string, readonly string[]>>): void {
  // One line per table rather than pretty-printed: 215 ramps of six hex strings is unreadable either way,
  // and a table per line at least makes a diff say *which family changed* when the pack is updated.
  const paletteBody = Object.keys(palettes)
    .sort()
    .map((table) => `  ${JSON.stringify(table)}: ${JSON.stringify(palettes[table])},`)
    .join('\n');
  const body = entries
    .map((e) => {
      const slot = e.slot ? `, slot: '${e.slot}'` : '';
      const recolours = e.recolours
        ? `, recolours: { material: '${e.recolours.material}', base: '${e.recolours.base}', ` +
          `ramps: ${JSON.stringify(e.recolours.ramps)} }`
        : '';
      const layers = e.layers.map((l) => `{ sheet: '${l.sheet}', z: ${l.z} }`).join(', ');
      return (
        `  { id: '${e.id}', name: ${JSON.stringify(e.name)}, kind: '${e.kind}'${slot}${recolours}, ` +
        `sheet: '${e.sheet}', z: ${e.z}, layers: [${layers}], authors: ${JSON.stringify(e.authors)}, ` +
        `licences: ${JSON.stringify(e.licences)} },`
      );
    })
    .join('\n');

  const paletteBlock =
    `\n/**\n` +
    ` * **A7e** — every colour ramp the pack ships, by table. \`cloth_ulpc.red\` is \`LPC_PALETTES.cloth_ulpc.red\`.\n` +
    ` *\n` +
    ` * Baked in rather than served: the whole set is 215 ramps across 12 files, 28 KB of JSON — smaller\n` +
    ` * than one sprite sheet. A route would be a route to keep working, an ordering problem at boot, and a\n` +
    ` * failure mode where the picker loads and the colours do not.\n` +
    ` *\n` +
    ` * A ramp is **ordered dark to light**, and that order is the recolour: position 0 maps to position 0,\n` +
    ` * so the shading survives and only the hue moves. Six entries everywhere except \`eye\`, which is three.\n` +
    ` */\n` +
    `export const LPC_PALETTES: Readonly<Record<string, Readonly<Record<string, Ramp>>>> = {\n${paletteBody}\n};\n`;

  writeFileSync(
    INDEX_FILE,
    `/**
 * **Generated by \`npm run artgen\` — do not edit.**
 *
 * The LPC art an item may be given, indexed from \`assets/ulpc\` (git-ignored, 1.5 GB). Every entry
 * resolved to a real 576×256 walk sheet, staged into \`packages/client/public/lpc/<id>.png\`, so the
 * id an item carries *is* the texture key and there is no path table to drift.
 *
 * Attribution for these files is generated beside them, in \`ATTRIBUTION-generated.md\`. The licences
 * are CC-BY-SA 3.0 / GPL / OGA-BY and attribution is mandatory — see \`CLAUDE.md\`.
 */

import type { Ramp, Recolours } from './recolour.ts';

/** One indexed piece of art. */
export interface ArtEntry {
  readonly id: string;
  readonly name: string;
  /** ULPC's own \`type_name\`, kept raw — the source's vocabulary. */
  readonly kind: string;
  /** Where it would ordinarily be worn. A hint for filtering a picker, enforced nowhere. */
  readonly slot?: string;
  /**
   * **A7e** — what this sheet may be recoloured into, or absent if it may not be.
   *
   * Absent is the useful half: 345 of the pack's 769 definitions declare no \`recolors\` at all, and a
   * picker offering a ramp for one of them would be offering a control that silently does nothing.
   */
  readonly recolours?: Recolours;
  /**
   * The front-most layer's texture key — what a **thumbnail** should draw.
   *
   * A mirror of the last entry in \`layers\`. **A renderer must use \`layers\`**: this alone is a
   * cloak's shoulders with no cloak under them.
   */
  readonly sheet: string;
  /** The front-most layer's \`zPos\`. Mirrors \`layers\`, same rule as \`sheet\`. */
  readonly z: number;
  /**
   * Every staged layer of this art, **in draw order** (lowest z first).
   *
   * Usually one. For a quarter of the pack it is more, and those extras are the halves that go
   * *behind* the body: a weapon carries a copy of itself drawn behind its wielder for the facings
   * where their back is turned, and a cape carries the whole hanging cloak beneath the character.
   * The z values are ULPC's own, so a renderer that sorts by z needs no rule about which is which.
   */
  readonly layers: readonly { readonly sheet: string; readonly z: number }[];
  readonly authors: readonly string[];
  readonly licences: readonly string[];
}

export const LPC_ART: readonly ArtEntry[] = [
${body}
];

/** By id, for the one question everything asks: is this a real piece of art, and which sheet is it? */
export const LPC_ART_BY_ID: ReadonlyMap<string, ArtEntry> = new Map(LPC_ART.map((a) => [a.id, a]));
${paletteBlock}`,
  );
}

/** One attribution file for everything staged. Generated, because a hand-kept one goes stale silently. */
function writeAttribution(entries: readonly ArtEntry[]): void {
  const byAuthor = new Map<string, number>();
  for (const entry of entries) for (const author of entry.authors) byAuthor.set(author, (byAuthor.get(author) ?? 0) + 1);
  const licences = [...new Set(entries.flatMap((e) => e.licences))].sort();

  const lines = [
    '# Attribution — generated by `npm run artgen`',
    '',
    'Art staged from the [Universal LPC Spritesheet Generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator).',
    'Every credit below is reproduced from that project’s own `sheet_definitions`, which is why this',
    'file is generated rather than kept by hand: a hand-kept one goes stale the first time a sheet is added.',
    '',
    `**${entries.length} sheets staged.** Licences in force across them: ${licences.join(', ')}.`,
    '',
    '## Authors',
    '',
    ...[...byAuthor.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a, n]) => `- ${a} (${n} sheets)`),
    '',
    '## Per sheet',
    '',
    '| id | name | authors | licences |',
    '| --- | --- | --- | --- |',
    ...entries.map((e) => `| \`${e.id}\` | ${e.name} | ${e.authors.join(', ')} | ${e.licences.join(', ')} |`),
    '',
  ];
  writeFileSync(ATTRIBUTION, `${lines.join('\n')}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const { entries, considered, skipped, collisions } = buildArtIndex();
  writeIndex(entries, readPalettes());
  writeAttribution(entries);
  const byKind = new Map<string, number>();
  for (const entry of entries) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
  console.log(`[artgen] ${considered} item-slot definitions considered, ${skipped} without a walk sheet`);
  console.log(`[artgen] ${entries.length} indexed and staged into packages/client/public/lpc/`);
  if (collisions.length > 0) {
    console.warn(
      `[artgen] ${collisions.length} left alone — a hand-staged sheet already owns the name: ` +
        `${collisions.join(', ')}`,
    );
  }
  console.log(
    `[artgen] ${[...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`,
  );
}
