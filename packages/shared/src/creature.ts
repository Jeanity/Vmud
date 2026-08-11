/**
 * Turning a creature's sprite key into the sheets that draw it.
 *
 * `mobpick` decides *what* a creature looks like and stores it as `body/head` — two of the pack's
 * own words. This is the other end: which staged textures that means. It lives in `shared` for the
 * usual reason, that the client draws the answer and the server validates it, and a second copy of
 * this lookup is a second thing to drift.
 *
 * ## The variant is resolved, not stored
 *
 * A sprite key names a shape (`wolf`), not a sheet (`head-shape-wolf-male`), and the difference is
 * the point. ULPC files heads under whatever variants that head happens to have: `wolf` has
 * male/female/child, `rabbit` has adult/child, `goblin` has adult/child, `human` has nine. Storing
 * the full sheet id would mean every override in the world breaks the day the pack reorganises a
 * directory, and it would mean whoever writes the override has to know which variants exist.
 *
 * So the body chooses the variant, and {@link creatureSheets} walks a preference list until it hits
 * one the index actually has. A `muscular` body asks for a `male` head and settles for `adult`; a
 * `child` body asks for `child` and settles for `adult`, because a small body with an adult head is
 * a goblin and a missing head is a headless man.
 *
 * ## Nothing here throws
 *
 * An unknown shape returns `undefined` and the caller draws the human it always drew — the same
 * degradation an unknown item art id already gets. A bulk assignment of fifteen hundred rows will
 * eventually contain a typo, and the honest failure for one is one ordinary-looking guard.
 */

import { CREATURE_LAYER_BY_ID } from './creature-art.ts';

/** What a sprite key resolves to: the sheets, in the order they stack. */
export interface CreatureSheets {
  /** The body. Always present when this resolves at all. */
  readonly body: string;
  /** The head shape, when the pack has one for this body. */
  readonly head?: string;
}

/**
 * Which head variant each body asks for, in order of preference.
 *
 * `adult` is the last real entry on every row because it is the pack's own catch-all — a head that
 * was drawn once and not split by sex files itself there, and rabbit, goblin and boarman all do.
 */
const HEAD_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  male: ['male', 'adult'],
  muscular: ['male', 'adult'],
  teen: ['male', 'adult'],
  female: ['female', 'adult'],
  pregnant: ['female', 'adult'],
  child: ['child', 'adult'],
  skeleton: ['skeleton', 'adult', 'male'],
  zombie: ['zombie', 'adult', 'male'],
};

/** What a body asks for when it is not in the table. */
const FALLBACK_VARIANTS = ['adult', 'male', 'default'] as const;

/**
 * The sheets a `body/head` key draws as, or `undefined` if the body is not one we staged.
 *
 * The head is optional in the result and that is deliberate: a body with no matching head still
 * draws, as a bald figure, which is a far better failure than nothing at all appearing.
 */
export function creatureSheets(sprite: string): CreatureSheets | undefined {
  const slash = sprite.indexOf('/');
  if (slash <= 0) return undefined;
  const bodyShape = sprite.slice(0, slash);
  const headShape = sprite.slice(slash + 1);
  if (!bodyShape || !headShape) return undefined;

  const body = `body-${bodyShape}`;
  if (!CREATURE_LAYER_BY_ID.has(body)) return undefined;

  for (const variant of [...(HEAD_VARIANTS[bodyShape] ?? []), ...FALLBACK_VARIANTS]) {
    const head = `head-shape-${headShape}-${variant}`;
    if (CREATURE_LAYER_BY_ID.has(head)) return { body, head };
  }
  return { body };
}

/** Whether a sprite key names something this build can actually draw. The panel's gate. */
export function isDrawableCreature(sprite: string): boolean {
  return creatureSheets(sprite) !== undefined;
}
