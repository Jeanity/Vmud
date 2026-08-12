/**
 * **Zero art assets in the build**, which is M3's own acceptance criterion and is worth a test
 * rather than a promise.
 *
 * The plan's reason is not tidiness. M4 is the go/no-go — *"Roughly 70% of why the reference image
 * looks the way it does is renderer, lighting, fog and grade — not meshes… If it reads as grey
 * cylinders under a blue filter, stop and reconsider before spending a single hour on assets."* A
 * single texture sneaking into the grey-box is a thumb on that scale, and the judgement it corrupts
 * is the one the whole 25–40 week estimate hangs on.
 *
 * So: nothing in this package may be a picture, a model or a sound, and there is no `public/`
 * directory for Vite to copy one out of. The one thing on disk that is not source is `index.html`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Anything a renderer could draw, load or play. */
const ART = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tga',
  '.svg',
  '.glb',
  '.gltf',
  '.fbx',
  '.obj',
  '.dae',
  '.ktx2',
  '.basis',
  '.dds',
  '.hdr',
  '.exr',
  '.mp3',
  '.ogg',
  '.wav',
]);

function walk(dir: string, found: string[]): void {
  for (const entry of readdirSync(dir)) {
    // Installed dependencies are full of art; the question is what *this package* ships.
    if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, found);
      continue;
    }
    if (ART.has(extname(entry).toLowerCase())) found.push(path);
  }
}

describe('the grey-box carries no art', () => {
  it('has no image, model or audio file anywhere in the package', () => {
    const found: string[] = [];
    walk(PACKAGE_ROOT, found);
    assert.deepEqual(found, [], `art in a grey-box package:\n${found.join('\n')}`);
  });

  it('has no public/ directory for Vite to copy assets out of', () => {
    assert.equal(existsSync(join(PACKAGE_ROOT, 'public')), false);
  });

  it('depends on three and on nothing else that draws', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@mygame/shared', 'three']);
    // Pinned exact, both of them: `@types/three` is DefinitelyTyped and lags releases, and
    // `postprocessing` (M4's) peers `three <0.186.0`, one minor from this pin. See §3 and risk 5.
    assert.equal(manifest.dependencies['three'], '0.185.1');
    assert.equal(manifest.devDependencies['@types/three'], '0.185.1');
    // M4's, M7's and click-to-move's dependencies must not have wandered in early.
    for (const early of ['postprocessing', 'troika-three-text', 'three-mesh-bvh']) {
      assert.ok(!(early in manifest.dependencies), `${early} is not M3's`);
      assert.ok(!(early in manifest.devDependencies), `${early} is not M3's`);
    }
  });
});
