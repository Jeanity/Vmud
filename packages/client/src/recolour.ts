/**
 * Making the recoloured sheet — **A7e**, the client half.
 *
 * `shared/recolour.ts` decides *which colours become which*; this turns that into a texture. The split is
 * the usual one for this project: the arithmetic is pure and tested, and the part that needs a canvas and
 * a network fetch lives on the side that has both.
 *
 * ## Why the client and not the server
 *
 * The roadmap left this as a fork and A7e took the render-time branch. Staging a recoloured PNG
 * server-side needs a PNG **decoder and encoder** the project does not have — `artgen` reads an IHDR
 * header and stops. The browser has both, for free, and `bagicon.ts` already proves the pattern works
 * here: the sheets are served from the client's own origin (`public/lpc/`), so `getImageData` is not
 * tainted and a readback costs one canvas.
 *
 * The consequence worth stating: **a recoloured sheet exists only in the tab that drew it.** Nothing is
 * written, nothing is staged, and `npm run artgen` has nothing new to own. The item carries the string
 * `cape-solid#cloth_ulpc.red` and every client makes the same pixels from it, which is the same guarantee
 * a staged file would give without the file.
 *
 * ## The texture key *is* the recoloured id
 *
 * A body's layers are looked up, sorted, drawn and redressed by texture key, so making the key
 * `cape-solid#cloth_ulpc.red` means every one of those paths works unchanged — they see a different
 * string and nothing more. That is why this file is small: it registers a texture, and the renderer
 * never learns that recolouring happened.
 */

import {
  LPC_ART_BY_ID,
  LPC_PALETTES,
  parseArtId,
  recolourPixels,
  splitRamp,
  swapsFor,
  type ColourSwap,
} from '@mygame/shared';

/**
 * The colour swaps a ramp implies for a given art, or nothing if it implies none.
 *
 * Three ways to get nothing, and each is a real case rather than defensive coding: the art is not
 * recolourable at all (345 of the pack's definitions declare no `recolors`), the ramp names a table that
 * is not baked in, or the target *is* the base — which is what picking the original colour back means and
 * which should cost no pixels at all.
 */
export function swapsForArt(artId: string, ramp: string): readonly ColourSwap[] {
  const entry = LPC_ART_BY_ID.get(artId);
  if (!entry?.recolours) return [];
  const target = splitRamp(ramp);
  if (!target) return [];
  const table = LPC_PALETTES[target.table];
  const to = table?.[target.name];
  if (!to) return [];
  // **The base ramp comes from the art, not from the ramp's own table**, and that is the subtlety: a
  // sheet drawn in `cloth`'s white can be recoloured into a ramp from `metal`, so the source and the
  // destination live in different tables. Reading the base out of the destination's table would recolour
  // from six colours the sheet does not contain, and the sheet would come back untouched.
  const baseTable = LPC_PALETTES[`${entry.recolours.material}_ulpc`] ?? LPC_PALETTES[target.table];
  const from = baseTable?.[entry.recolours.base];
  if (!from) return [];
  return swapsFor(from, to);
}

/**
 * Fetches a sheet, recolours it, and hands back a canvas ready to be registered as a texture.
 *
 * `null` for a sheet that will not load, so the caller can fall back to the uncoloured original rather
 * than leave a body with a hole in it — a missing hat is better than a missing person.
 */
export async function recolouredSheet(sheet: string, swaps: readonly ColourSwap[]): Promise<HTMLCanvasElement | null> {
  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img));
    img.addEventListener('error', () => resolve(null));
    img.src = `lpc/${sheet}.png`;
  });
  if (!image) return null;

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  recolourPixels(pixels.data, swaps);
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

/**
 * Every texture key a piece of art needs, ramp and all.
 *
 * The one function that knows a recoloured id is two things joined by a `#`. A plain id resolves exactly
 * as it did before A7e, which is what keeps 16,000 unrecoloured items on the path they were already on.
 */
export function layerKeysFor(art: string): { readonly key: string; readonly sheet: string; readonly z: number }[] {
  const { id, ramp } = parseArtId(art);
  const entry = LPC_ART_BY_ID.get(id);
  const layers = entry?.layers ?? [{ sheet: id, z: 50 }];
  // The **key** carries the ramp and the **sheet** is what to fetch. Keeping both means the loader knows
  // which PNG to ask for and the renderer knows which texture it is stacking, with no table between them.
  return layers.map((layer) => ({ key: ramp ? `${layer.sheet}#${ramp}` : layer.sheet, sheet: layer.sheet, z: layer.z }));
}

/** Whether a texture key names a recoloured sheet, and what it was made from. */
export function readLayerKey(key: string): { readonly sheet: string; readonly ramp?: string } {
  const at = key.indexOf('#');
  if (at < 0) return { sheet: key };
  return { sheet: key.slice(0, at), ramp: key.slice(at + 1) };
}

/**
 * The art id a recoloured layer key belongs to — needed because the swaps are a property of the *art*
 * (its material and base), not of the individual layer sheet.
 *
 * A cape is two sheets, `cape-solid` and `cape-solid-l2`, and both recolour from `cloth`'s white. Looking
 * the swaps up per sheet would miss on the second, and the cloak would hang behind a recoloured collar in
 * its original colour — which is exactly the class of bug A7a spent a session on.
 */
export function artIdForSheet(sheet: string): string {
  if (LPC_ART_BY_ID.has(sheet)) return sheet;
  const trimmed = sheet.replace(/-l\d+$/, '');
  return LPC_ART_BY_ID.has(trimmed) ? trimmed : sheet;
}
