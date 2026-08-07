/**
 * Stages the **action sheets** — slash, thrust, spellcast, hurt — for the full-fidelity set: the
 * sheets that already have a hand-staged `-idle` twin (the starter kit and the body), plus nothing
 * else. The owner's ask (2026-08-07): *"we will need attacks/spellcasts/bashed/sitting and whatever
 * else requires a visual queue animated."*
 *
 * ## Why only the idle-twinned set
 *
 * The precedent is idle itself. Phase 15a staged `-idle` twins for the ~14 starter sheets and left
 * the 16k-item indexed catalogue walk-only; the renderer's pose swap is guarded per layer on
 * `textures.exists`, so a layer without the twin simply holds its walk frame — graceful, already
 * shipped, already understood. Actions follow the identical contract: a starter-kit body swings
 * whole, an authored cloak on it holds its frame the way it already does when standing. Staging all
 * four actions for the whole catalogue would be ~1,700 tracked PNGs for gear mostly never worn, and
 * recoloured (`#ramp`) layers would need runtime canvas twins besides — a later slice if wanted.
 *
 * ## Which pack, and how the source is found
 *
 * **The starter kit came from `assets/lpc-opengameart`, not the ULPC generator pack** — measured by
 * byte identity, not remembered: the staged body sheet hashes to
 * `sprite/character/Body/Base/Human_male/Ivory/walk.png` there, and no ULPC file matches (the ULPC
 * default body differs on 79% of opaque pixels — a different skin lineage, which is why the sit
 * sheet ULPC ships cannot be mixed in). So each staged walk sheet is hash-matched against the old
 * pack, and the animation siblings sit **beside it in the same directory** under the old pack's own
 * names: `swing` is our slash, `magic` our spellcast, `thrust` and `hurt` themselves.
 *
 * **`hurt` is the down pose.** The old pack ships no `sit`, and hurt's final frame is the body flat
 * on the ground — one frame that serves every non-standing posture (a bash's *"knocked to the
 * ground"*, sleep, rest, the dying window) at every facing, because a body on the ground has no
 * facing worth drawing. Measured: none of these sheets carries a trailing padding column (the walk
 * trap), so every column is a real frame and the renderer may trust texture width.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PACK = process.env.GAME_LPC_KIT_PACK
  ? resolve(process.env.GAME_LPC_KIT_PACK)
  : join(REPO_ROOT, 'assets', 'lpc-opengameart');
const SPRITESHEETS = join(PACK, 'sprite');
const STAGED = join(REPO_ROOT, 'packages', 'client', 'public', 'lpc');

/** Staged suffix → the old pack's own file name for that animation. */
const ACTIONS: readonly { readonly suffix: string; readonly packName: string }[] = [
  { suffix: 'slash', packName: 'swing' },
  { suffix: 'thrust', packName: 'thrust' },
  { suffix: 'spellcast', packName: 'magic' },
  { suffix: 'hurt', packName: 'hurt' },
];

function sha1(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

/** Every PNG under the pack's spritesheets, grouped by size so hashing only touches candidates. */
function packPngsBySize(): Map<number, string[]> {
  const bySize = new Map<number, string[]>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.png')) {
        const size = statSync(path).size;
        const list = bySize.get(size);
        if (list) list.push(path);
        else bySize.set(size, [path]);
      }
    }
  };
  walk(SPRITESHEETS);
  return bySize;
}

/** The animation sibling: the old pack keeps every animation as a file beside walk.png. */
function siblingFor(walkPath: string, packName: string): string | undefined {
  const sibling = walkPath.replace(/([\\/])walk\.png$/, `$1${packName}.png`);
  if (sibling !== walkPath && existsSync(sibling)) return sibling;
  return undefined;
}

if (!existsSync(SPRITESHEETS)) {
  console.error(`no pack at ${SPRITESHEETS} — set GAME_LPC_KIT_PACK (a worktree has no assets/; point it at D:/MyGame/assets/lpc-opengameart)`);
  process.exit(1);
}

// The full-fidelity set selects itself: whatever 15a gave an idle twin.
const kit = readdirSync(STAGED)
  .filter((f) => f.endsWith('-idle.png'))
  .map((f) => f.replace(/-idle\.png$/, ''));
if (kit.length === 0) {
  console.error(`no -idle twins under ${STAGED} — nothing selects the full-fidelity set`);
  process.exit(1);
}

const bySize = packPngsBySize();
let staged = 0;
let already = 0;
const missing: string[] = [];

for (const name of kit) {
  const walkStaged = join(STAGED, `${name}.png`);
  if (!existsSync(walkStaged)) {
    missing.push(`${name}: staged walk sheet missing`);
    continue;
  }
  const wanted = sha1(walkStaged);
  const candidates = bySize.get(statSync(walkStaged).size) ?? [];
  const source = candidates.find((path) => sha1(path) === wanted);
  if (!source) {
    // Not fatal: a sheet touched after staging (recoloured by hand?) simply keeps walk-only fidelity.
    missing.push(`${name}: no byte-identical source in the pack`);
    continue;
  }
  for (const { suffix, packName } of ACTIONS) {
    const sibling = siblingFor(source, packName);
    const dest = join(STAGED, `${name}-${suffix}.png`);
    if (!sibling) {
      missing.push(`${name}-${suffix}: the pack has no ${packName} sheet beside ${source.slice(PACK.length + 1)}`);
      continue;
    }
    if (existsSync(dest) && sha1(dest) === sha1(sibling)) {
      already++;
      continue;
    }
    copyFileSync(sibling, dest);
    staged++;
    console.log(`staged ${name}-${suffix}.png  <-  ${sibling.slice(PACK.length + 1)}`);
  }
}

console.log(`\n${staged} staged, ${already} already current, over ${kit.length} full-fidelity sheets.`);
if (missing.length > 0) {
  console.log(`\nnot staged (each keeps its walk-frame fallback):`);
  for (const line of missing) console.log(`  ${line}`);
}
