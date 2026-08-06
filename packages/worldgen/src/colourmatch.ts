/**
 * Whose loot is whose — the zone half of the bulk colour pass. **A7h.**
 *
 * The roadmap's prize, held out since A7e was written: *"a pass could propose art **and** ramp for a
 * whole zone's loot without anybody retyping a description."* A7g did the art half catalogue-wide, and
 * A7f built the colour matcher one item at a time; this is what points the second at the first.
 *
 * ## Why a zone rather than the catalogue
 *
 * A7g ran over all 16,421 items at once and that was right for art, because every item wants a picture
 * and nobody was ever going to review 16,000 rows — the fallback made the bad ones *visibly* bad and the
 * panel is the review tool. Colour is different in one respect that changes the shape: **most items
 * should not get one.** A ramp is only right when the name actually says a colour, so a catalogue-wide
 * pass is mostly *no opinion*, and the interesting output is a short list.
 *
 * A zone is the unit an operator actually works in — 1 to 131 items across the shipped world, measured —
 * and it is the unit their attention has: they are dressing the Kobold Settlement, not the world.
 *
 * ## What counts as a zone's loot
 *
 * Every object vnum any of its reset commands names. Four kinds do:
 *
 * - `give` and `equip` put a thing **on a mob** — the loot a player takes off a corpse, which is the
 *   overwhelming majority and the reason this is worth doing.
 * - `object` puts one **in a room**, and `put` puts one **inside a container**. Both are things a player
 *   picks up, so both belong.
 *
 * Shop inventories are deliberately **not** here: a shopkeeper's stock is a list on the mob rather than a
 * reset command, it is often the same catalogue entry a dozen zones sell, and colouring it from one
 * zone's pass would quietly recolour it everywhere. That is a decision for the whole catalogue, not for
 * whoever happened to run this on zone 168 first.
 */

import type { ZoneSpawns } from '@mygame/shared';

/** The reset kinds that name an **object** rather than a mob. `mob`, `door` and `follower` do not. */
const OBJECT_KINDS = new Set(['give', 'equip', 'put', 'object']);

/**
 * Every distinct item vnum a zone's resets place, in the order the table names them.
 *
 * Order matters only for the report: reading the proposals in reset order groups a mob with the kit it
 * is dressed in, which is how somebody reviewing them is thinking about it.
 */
export function lootOf(spawns: Pick<ZoneSpawns, 'resets'>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const reset of spawns.resets) {
    if (!OBJECT_KINDS.has(reset.kind)) continue;
    if (seen.has(reset.what)) continue;
    seen.add(reset.what);
    out.push(reset.what);
    // **`put` also names a container**, and the container is itself an item somebody carries — so it is
    // loot too, and missing it would leave the one thing in a room a player definitely sees uncoloured.
    if (reset.kind === 'put' && reset.container !== undefined && !seen.has(reset.container)) {
      seen.add(reset.container);
      out.push(reset.container);
    }
  }
  return out;
}

/** One item's outcome in a bulk pass, for the report and for the write. */
export interface ColourProposal {
  readonly vnum: number;
  readonly name: string;
  /** The art it wears, ramp and all, as it would be written. */
  readonly art: string;
  readonly ramp: string;
  /** The word in the item's own name that decided it. */
  readonly because: string;
}

/** Why an item was passed over. Counted and reported, never silent — A7g's rule. */
export type ColourSkip =
  | 'no-art'
  | 'not-recolourable'
  | 'already-coloured'
  | 'skin-toned-art'
  | 'no-colour-in-the-name';

export interface ColourReport {
  readonly proposals: readonly ColourProposal[];
  readonly skipped: Readonly<Record<ColourSkip, number>>;
}
