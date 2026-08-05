/**
 * Where an indexed LPC sheet lives on disk — A7c, so the admin panel can show one.
 *
 * ## Why the server serves art at all
 *
 * `artgen` stages every sheet into `packages/client/public/lpc/<id>.png`, where the *client's* dev
 * server hands it to players. The admin panel is a different origin (5274 against 5273) and proxies
 * only `/admin`, so a picker built against the client's port would be a panel that breaks whenever
 * somebody runs the server and the panel without the game — which is the case the admin suite exists
 * for. The game server is the one thing the panel is defined against (`admin/src/api.ts`), so the
 * sheet comes from there.
 *
 * **The same file, not a copy.** Reading the client's staged PNG rather than staging a second set
 * means a re-run of `npm run artgen` cannot leave the picker showing art the game no longer has —
 * the two would drift silently, and the symptom would be an operator choosing a sheet that renders
 * as Phaser's `__MISSING` box on a body.
 *
 * ## The id is looked up, never joined
 *
 * {@link artSheetPath} resolves through {@link LPC_ART_BY_ID} and builds the path from the *entry's*
 * `sheet`, so no part of the request ever reaches `join`. Traversal is therefore closed by
 * construction rather than by sanitising: `../../../.ssh/id_rsa` is not an art id, so there is
 * nothing to escape and no filter to get wrong. The index is generated, so this also means the route
 * can only ever serve a file `artgen` put there.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LPC_ART_BY_ID } from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where `artgen` stages the sheets. One directory, shared with the client by design — see above. */
export const SHEET_DIR = join(REPO_ROOT, 'packages', 'client', 'public', 'lpc');

/** The URL path the panel asks on, and the prefix `index.ts` routes. */
export const SHEET_ROUTE = '/lpc/';

/**
 * The staged PNG for an art id, or undefined for an id the index does not have.
 *
 * Undefined rather than a thrown error because "no such art" is a 404 and not a fault: an operator
 * whose panel is open across a re-stage that dropped a sheet should get a missing thumbnail, not a
 * server that logs a stack trace.
 */
export function artSheetPath(id: string): string | undefined {
  const entry = LPC_ART_BY_ID.get(id);
  if (!entry) return undefined;
  return join(SHEET_DIR, `${entry.sheet}.png`);
}

/**
 * Pulls the art id out of a `/lpc/<id>.png` request, or undefined for anything else.
 *
 * Split out from the route so the parsing has a test: `index.ts` starts a server on import and has
 * no harness, which is the reason three bugs in `HANDOFF.md` had to be found by driving the game.
 * A query string is tolerated because a browser cache-buster is a thing an operator's tooling adds.
 */
export function artIdFromPath(url: string): string | undefined {
  const path = url.split('?')[0] ?? '';
  if (!path.startsWith(SHEET_ROUTE) || !path.endsWith('.png')) return undefined;
  const id = path.slice(SHEET_ROUTE.length, -'.png'.length);
  return id.length > 0 ? id : undefined;
}
