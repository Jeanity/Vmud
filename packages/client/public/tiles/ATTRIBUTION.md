# Tile artwork attribution

These tiles come from the **Liberated Pixel Cup (LPC)** asset set, via the official repository at
<https://github.com/OpenGameArt/LiberatedPixelCup> (`tileset/original/Sharm/outdoor/PNG`).

## Authors

- **Lanea Zimmerman (Sharm)** — <https://opengameart.org/user/1727>
- **Daniel Armstrong (HughSpectrum)** — <https://opengameart.org/user/2535>

## Licence

Dual licensed under **CC-BY-SA 3.0** and **GPL 3.0**. Full texts accompany these files as
`LICENSE-CC-BY-SA-3.0.txt` and `LICENSE-GPL-3.0.txt`.

Both licences are **share-alike**: attribution must be preserved and derivative artwork must be
released under compatible terms. Keep this file, the licence texts, and the authors list together
with the images in any build that ships them.

## Files used

| File | Used for |
| --- | --- |
| `grass.png` | field, forest, hills |
| `grassalt.png` | terrain variation |
| `dirt.png` | roads, desert |
| `dirt2.png` | interiors, mountain, swamp |
| `water.png` | deep water, underwater |
| `watergrass.png` | shallow water |
| `hole.png` | caves, astral |
| `rock.png` | scatter decoration |
| `cobbles.png` | city flagstone |
| `treetop.png`, `trunk.png` | tree decoration |
| `props/*.png` | scenery — the things that stand in a room |

No changes have been made to the source images; tiles are selected by frame index at run time.

`cobbles.png` is four 32px grey cobblestone fills extracted unmodified from `terrain-v7.png` in
**"[LPC] Terrains"** — bluecarrot16, Lanea Zimmerman (Sharm), Daniel Eddeland (Daneeklu), Richard
Kettering (Jetrel), Zachariah Husiar (Zabin), Hyptosis, Casper Nilsson, Buko Studios, Nushio,
ZaPaper, billknye, William Thompson, caeles, Redshrike, Bertram, and Rayane Félix (RayaneFLX) —
CC-BY-SA 3.0 / GPL 3.0. The atlas is vendored at `assets/love2d-lpc-tiles/` (untracked, from
<https://github.com/DrJamgo/love2d-lpc-tiles>), whose `CREDITS-terrain-v7.txt` is the authoritative
per-source record. Drawn untinted.

`props/` is six sprites cut unmodified from `decorations-medieval.png` in the same vendored atlas —
`fountain` (three animation frames), `plinth`, `well`, `statue`, `cart`, `haystack`. That sheet is
itself a compilation, and its `CREDITS-decorations-medieval.txt` is the authoritative per-source
record; the contributors it names are **Reemax (Tuomo Untinen), Lanea Zimmerman (Sharm), Xenodora,
Johann C, Johannes Sjölund, Hyptosis, Daniel Armstrong (HughSpectrum), Redshrike,
William Thompson and wulax**, under CC-BY-SA 3.0 / GPL 3.0 (parts also GPL 2.0).

Cutting is the only edit: each file is a rectangular crop at the atlas's own 32px grid, so a prop's
art size is its footprint in tiles, and the frames of an animated prop lie left to right.
