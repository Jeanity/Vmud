/**
 * The picture on a bag row — **A7d-bag**, and the second half of A7d.
 *
 * A7d put an item's own art on the floor instead of one of nine category glyphs. The drawer was left
 * out, and the roadmap said exactly why: *"it wants an art id per `BagRow`, which is a protocol addition
 * rather than a rendering change."* Protocol 20 is that addition; this is the rendering.
 *
 * ## Why this is not the scene's job
 *
 * The drawer is **DOM**, like the combat feed, the place map and the group roster, and for the same
 * reason: a list of rows with pictures in it is the browser's job, it owes the renderer nothing, and it
 * stays legible if anything goes wrong inside the canvas. So the icon cannot come out of a Phaser
 * texture — it is an `<img>` in a panel Phaser does not own.
 *
 * ## The crop is A7d's, measured the same way, for the same reason
 *
 * An LPC frame is **person-shaped**: a cloak fills the lower half of a 64×64 box sized for a whole body,
 * so a centred frame draws the object low under a void, which is what the owner reported as *"the cloak
 * sitting at the bottom of the image"*. A7d fixed it by cropping to the content's alpha bounding box, and
 * the same rule has to hold here or the drawer would reintroduce a solved bug at a quarter of the size.
 *
 * Done with a plain canvas rather than through the scene: the client serves these PNGs from its own
 * origin (`public/lpc/`), so `getImageData` is not tainted, and one readback per art is cached for the
 * life of the tab. A 22-pixel icon is not worth a second code path in the renderer.
 *
 * ## The facing is measured, not assumed — A7d's other finding, paid off
 *
 * A7d used **column 0 of row 2**, LPC's south-facing standing pose, and recorded the flaw that leaves:
 * *"south is the wrong frame for a garment — `cape-solid` has 526 opaque pixels in its north row vs 62 in
 * south, because facing you a cloak hangs behind you and the front view is only the hem."* Its write-up
 * named the fix — pick the facing with the most content — and deferred it because doing it in `artgen`
 * needs a PNG decoder there.
 *
 * Here it costs one loop, because the browser has already decoded the sheet: all four facings are
 * counted and the fullest wins. Measured live, that takes `cape-solid` from an 11-pixel sliver of hem to
 * the whole hanging cloak. **The floor icons still use row 2** and want the same treatment; the honest
 * home for it is still `artgen`, measured once per sheet rather than once per client.
 *
 * Not the pack's `preview_row`/`preview_column`, which only 24 of 657 definitions carry.
 */

/** One frame of a walk sheet. */
const FRAME = 64;
/** LPC's row order is north, west, south, east. All four are candidates — see above. */
const FACINGS = 4;
/** A sprite trimmed flush against the edge of a 22-pixel box reads as clipped rather than as cropped. */
const MARGIN = 1;

/** Art id → a cropped data URL, or `null` for one that could not be made. Cached either way. */
const cache = new Map<string, string | null>();
/** In-flight loads, so a bag holding four leather caps decodes one sheet. */
const pending = new Map<string, Promise<string | null>>();

/**
 * The cropped icon for an art id, or `null` when there is nothing to draw.
 *
 * Resolves to `null` rather than throwing on every failure — a missing sheet, a frame that is entirely
 * transparent, a canvas the browser will not give a context for. The drawer's fallback is the name it has
 * always shown, which is a complete row on its own; a missing picture must not cost the player the line.
 */
export function bagIcon(art: string): Promise<string | null> {
  const done = cache.get(art);
  if (done !== undefined) return Promise.resolve(done);
  const already = pending.get(art);
  if (already) return already;

  const work = load(art)
    .then((url) => {
      cache.set(art, url);
      pending.delete(art);
      return url;
    })
    .catch(() => {
      cache.set(art, null);
      pending.delete(art);
      return null;
    });
  pending.set(art, work);
  return work;
}

function load(art: string): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image();
    // Same-origin: the client serves `public/lpc/` itself, which is what keeps the readback below legal.
    image.src = `/lpc/${art}.png`;
    image.addEventListener('error', () => resolve(null));
    image.addEventListener('load', () => resolve(crop(image)));
  });
}

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Takes the fullest facing's standing frame and returns it trimmed to its own content. */
function crop(image: HTMLImageElement): string | null {
  // Narrower than one frame is not a walk sheet, and cropping it would read garbage out of the next row.
  // Height is checked per facing below, so a short sheet simply offers fewer candidates.
  if (image.width < FRAME || image.height < FRAME) return null;

  const scratch = document.createElement('canvas');
  scratch.width = FRAME;
  scratch.height = FRAME;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  let best: { row: number; box: Box; pixels: number } | undefined;
  for (let row = 0; row < FACINGS; row++) {
    if (image.height < FRAME * (row + 1)) break;
    ctx.clearRect(0, 0, FRAME, FRAME);
    ctx.drawImage(image, 0, row * FRAME, FRAME, FRAME, 0, 0, FRAME, FRAME);
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, FRAME, FRAME).data;
    } catch {
      // A tainted canvas. Cannot happen while the sheets are same-origin, and nothing is the right
      // answer if that ever stops being true.
      return null;
    }
    const measured = bounds(data);
    // **Most opaque pixels wins, not the largest box.** A cloak's hem is wide and flat, so comparing
    // boxes would pick the very sliver this is trying to avoid; what says "this facing shows the thing"
    // is how much of the thing is drawn.
    if (measured && (!best || measured.pixels > best.pixels)) best = { row, ...measured };
  }
  // Nothing drawn in any facing. Half the pack has a blank column 8 and some sheets have empty facings,
  // so an empty result is a real case rather than a defensive flourish.
  if (!best) return null;

  const x = Math.max(0, best.box.minX - MARGIN);
  const y = Math.max(0, best.box.minY - MARGIN);
  const width = Math.min(FRAME, best.box.maxX + 1 + MARGIN) - x;
  const height = Math.min(FRAME, best.box.maxY + 1 + MARGIN) - y;

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const target = out.getContext('2d');
  if (!target) return null;
  // **From the source image at the winning row**, not from `scratch` — which holds whichever facing the
  // loop drew last and is the winner only by luck.
  target.drawImage(image, x, best.row * FRAME + y, width, height, 0, 0, width, height);
  return out.toDataURL('image/png');
}

/** The alpha bounding box of one frame, and how much of it is drawn at all. */
function bounds(data: Uint8ClampedArray): { box: Box; pixels: number } | undefined {
  let minX = FRAME;
  let minY = FRAME;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let y = 0; y < FRAME; y++) {
    for (let x = 0; x < FRAME; x++) {
      // Alpha only. A fully transparent pixel is not content however coloured its RGB happens to be —
      // and LPC sheets do carry colour under zero alpha.
      if (data[(y * FRAME + x) * 4 + 3] === 0) continue;
      pixels++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return undefined;
  return { box: { minX, minY, maxX, maxY }, pixels };
}
