/**
 * The same garment in another colour — **A7e**.
 *
 * Owner's ask, 2026-08-05: *"if I need a fiery red cloak I can select the black one and change the
 * colors."* This is **not an image editor**, and that is the whole reason it is cheap: ULPC ships a
 * palette-recolour system (`PALETTE_RECOLOR_GUIDE.md`, `palette_definitions/`), where a colour variant is
 * not a separate image but **one source sheet plus a named ramp**.
 *
 * ## The architectural call, which the roadmap said to make before writing code
 *
 * The parking lot assumed a server-side recolour that **stages a new PNG**. That is the wrong half of the
 * fork and this file takes the other one — **the recolour happens at render time**, for four reasons that
 * compound:
 *
 * 1. **It needs no PNG codec.** `artgen` reads an IHDR header and nothing else; staging a recoloured sheet
 *    would need a full decoder *and* encoder the project does not have. The client already reads pixels
 *    back off a loaded texture — A7d's bag icon does exactly that — so the capability is present on the
 *    side that would use it.
 * 2. **It needs no protocol change.** A ramp is part of *what the thing is*, so `cape-solid#red` in the
 *    `art` field an item already carries is the whole wire format. Nothing new is sent, nothing new is
 *    stored, and `wearing` keeps its shape.
 * 3. **It creates no ids to own.** A staged sheet would need an allocated id, an `ATTRIBUTION` line and
 *    the `previouslyGenerated` ownership check, or the next `npm run artgen` would eat it. A suffix on an
 *    existing id has none of those problems and cannot collide with a future pack entry.
 * 4. **It is what the pack itself does.** ULPC's own reference implementation recolours on a canvas at
 *    display time; following it means the guide's tolerance rule is transcribable rather than reinvented.
 *
 * ## The recolour is a colour map, index by index
 *
 * A family declares a **base** ramp in its metadata — cloth's is `white`, body's `light`, hair's
 * `orange`, wood's `maple`, metal's `steel`. Every sheet in that family is drawn *in the base ramp*, so
 * recolouring is: for each of the base ramp's colours, replace it with the colour at the same index in
 * the target ramp. Ramps are six colours everywhere except `eye`, which is three.
 *
 * **A sheet definition may override its family's base**, and that is a measurement the roadmap's five did
 * not include: `arms_hands_ring_stud` declares `"base": "teal"` while sitting in the `cloth` family. Read
 * the definition first and the family second, or that ring recolours from the wrong six colours and comes
 * out looking like nothing in particular.
 *
 * ## The tolerance, and why it is not zero
 *
 * `PALETTE_RECOLOR_GUIDE.md` matches at **±1 per channel**. Sheets have been through enough hands that a
 * pixel meant to be `#4B2B13` is sometimes `#4C2B13`, and an exact match leaves those pixels the base
 * colour — which reads as dirt on the recoloured garment rather than as a miss. See {@link nearestRamp}.
 */

/** A ramp: six colours dark-to-light, or three for `eye`. Hex strings as the pack writes them. */
export type Ramp = readonly string[];

/** Every ramp of one family and version, by name — `cloth_ulpc` is `{ brown: [...], red: [...] }`. */
export type RampTable = Readonly<Record<string, Ramp>>;

/** What one art may be recoloured into. Harvested from the sheet definition's `recolors`. */
export interface Recolours {
  /** The family whose base ramp this sheet is drawn in — `cloth`, `metal`, `body`, `hair`, `wood`, `eye`. */
  readonly material: string;
  /** The ramp it is drawn in. The definition's own `base` where it has one, else the family's. */
  readonly base: string;
  /** Every ramp it may be recoloured to, as `family_version.ramp` — the key {@link parseArtId} yields. */
  readonly ramps: readonly string[];
}

/** The separator between an art id and a ramp. `cape-solid#cloth_ulpc.red`. */
export const RAMP_SEPARATOR = '#';

/**
 * Splits `cape-solid#cloth_ulpc.red` into the art and the ramp.
 *
 * **Total, and never throws.** An id with no separator is an art with no recolour, which is the ordinary
 * case and the one every caller before A7e was written against — so an unrecoloured item keeps working
 * through this function unchanged, and a malformed one degrades to its base art rather than to nothing.
 */
export function parseArtId(art: string): { readonly id: string; readonly ramp?: string } {
  const at = art.indexOf(RAMP_SEPARATOR);
  if (at < 0) return { id: art };
  const ramp = art.slice(at + 1);
  return ramp ? { id: art.slice(0, at), ramp } : { id: art.slice(0, at) };
}

/** The inverse. An empty ramp gives the bare id, so *no recolour* has exactly one spelling. */
export function formatArtId(id: string, ramp: string | undefined): string {
  return ramp ? `${id}${RAMP_SEPARATOR}${ramp}` : id;
}

/** Splits `cloth_ulpc.red` into the table it lives in and the ramp's name within it. */
export function splitRamp(ramp: string): { readonly table: string; readonly name: string } | undefined {
  const at = ramp.indexOf('.');
  if (at <= 0 || at === ramp.length - 1) return undefined;
  return { table: ramp.slice(0, at), name: ramp.slice(at + 1) };
}

/** `#4B2B13` → `[75, 43, 19]`. Nothing for anything that is not a six-digit hex colour. */
export function parseHex(hex: string): readonly [number, number, number] | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** One colour swapped for another, as the renderer wants it: source RGB, destination RGB. */
export interface ColourSwap {
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
}

/**
 * The swaps that turn a sheet drawn in `base` into the same sheet in `target`.
 *
 * **Index by index**, which is the guide's rule and the reason a ramp is an ordered array rather than a
 * set: position 0 is the darkest shade in both, so the shading survives the swap and only the hue moves.
 *
 * Ramps of unequal length are truncated to the shorter rather than refused. That case is a family mixing
 * `eye`'s three-colour ramps with a six-colour one, which the pack does not currently do — but truncating
 * recolours the shades that *do* correspond and leaves the rest alone, where refusing would silently give
 * back the base sheet and look like the feature failing.
 */
export function swapsFor(base: Ramp, target: Ramp): readonly ColourSwap[] {
  const swaps: ColourSwap[] = [];
  const shared = Math.min(base.length, target.length);
  for (let i = 0; i < shared; i++) {
    const from = parseHex(base[i]!);
    const to = parseHex(target[i]!);
    if (!from || !to) continue;
    // A swap to the same colour is dropped rather than kept: it is work the renderer would do per pixel
    // for no visible effect, and `red → red` is a real case whenever somebody picks the base ramp back.
    if (from[0] === to[0] && from[1] === to[1] && from[2] === to[2]) continue;
    swaps.push({ from, to });
  }
  return swaps;
}

/** How far apart two colours are, per channel — the guide matches on the largest of the three. */
function channelDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/**
 * Which swap a pixel takes, within the guide's tolerance — or nothing, leaving the pixel alone.
 *
 * `PALETTE_RECOLOR_GUIDE.md` matches at **±1 per channel**, and that slack is load-bearing rather than
 * defensive: the sheets have been through many hands, so a pixel meant to be `#4B2B13` is here and there
 * `#4C2B13`. Exact matching leaves those at the base colour, which on a recoloured garment reads as dirt
 * rather than as a near miss — one stray dark pixel on a red cloak is more noticeable than a hundred.
 *
 * **The nearest match wins, not the first**, which matters where two ramp entries are within tolerance of
 * each other: taking the first would make the result depend on the ramp's order rather than on the pixel.
 */
export function nearestSwap(
  pixel: readonly [number, number, number],
  swaps: readonly ColourSwap[],
  tolerance = RECOLOUR_TOLERANCE,
): ColourSwap | undefined {
  let best: ColourSwap | undefined;
  let bestDistance = tolerance + 1;
  for (const swap of swaps) {
    const distance = channelDistance(pixel, swap.from);
    if (distance < bestDistance) {
      best = swap;
      bestDistance = distance;
    }
  }
  return best;
}

/** `PALETTE_RECOLOR_GUIDE.md`'s own slack: a channel may be one off and still be that colour. */
export const RECOLOUR_TOLERANCE = 1;

/**
 * A whole RGBA buffer recoloured in place. Returns how many pixels moved.
 *
 * Written against a plain `Uint8ClampedArray` so it is testable without a canvas — the client hands it
 * `ImageData.data` and nothing here knows that. **Fully transparent pixels are skipped**: a sheet's
 * padding is `#00000000`, and the darkest ramp entry of several families is near-black, so recolouring
 * the transparent border would tint the empty half of every frame.
 */
export function recolourPixels(
  data: Uint8ClampedArray,
  swaps: readonly ColourSwap[],
  tolerance = RECOLOUR_TOLERANCE,
): number {
  if (swaps.length === 0) return 0;
  let moved = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const swap = nearestSwap([data[i]!, data[i + 1]!, data[i + 2]!], swaps, tolerance);
    if (!swap) continue;
    data[i] = swap.to[0];
    data[i + 1] = swap.to[1];
    data[i + 2] = swap.to[2];
    moved++;
  }
  return moved;
}

/**
 * Whether an art value names real art, **ramp and all** — the one gate every writer runs.
 *
 * A7e made `art` two things joined by a `#`, and three separate validators were checking it with
 * `LPC_ART_BY_ID.has(value)` — which a recoloured id fails, because the map is keyed by the bare id. The
 * symptom was the whole feature silently not saving: the picker offered 99 colours, the operator chose
 * one, the router refused it *by name*, and the item kept its old art.
 *
 * Both halves are checked. A ramp the art does not offer is refused rather than ignored, because
 * `cloth_ulpc.red` on a steel helm would recolour from the wrong base and produce a sheet that looks
 * untouched — indistinguishable from the save having failed.
 *
 * The lookups are injected rather than imported so this file stays free of the generated index, which is
 * what lets it be tested against three colours instead of 346 sheets.
 */
export function isKnownArt(
  value: string,
  artById: ReadonlyMap<string, { readonly recolours?: Recolours }>,
): boolean {
  const { id, ramp } = parseArtId(value);
  const entry = artById.get(id);
  if (!entry) return false;
  if (ramp === undefined) return true;
  return entry.recolours?.ramps.includes(ramp) ?? false;
}
