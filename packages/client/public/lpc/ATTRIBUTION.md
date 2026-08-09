# Character artwork attribution

These character layers come from the **Liberated Pixel Cup (LPC)** asset set, via the official
repository at <https://github.com/OpenGameArt/LiberatedPixelCup> (`sprite/character`).

## Authors

- **Stephen Challener (Redshrike)** — <https://opengameart.org/user/47> — the human base template all
  of these layers are drawn against.
- **Johannes Sjölund (wulax)** — <https://opengameart.org/user/26591> — clothing and armour layers.
- **Matthew Krohn (makrohn)** — <https://opengameart.org/user/13268> — layer assembly and colour
  variants.
- **William Thompson (William.Thompsonj)** — <https://opengameart.org/user/7593> — commissioning and
  additional sheets.

The upstream per-asset credit lists are `sprite/original/authors.md` and
`sprite/derivative/authors.md` in the repository above, and they are the authoritative record.

## Licence

Dual licensed under **CC-BY-SA 3.0** and **GPL 3.0**. Full texts accompany these files as
`LICENSE-CC-BY-SA-3.0.txt` and `LICENSE-GPL-3.0.txt`.

Both licences are **share-alike**: attribution must be preserved and derivative artwork must be
released under compatible terms. Keep this file, the licence texts, and the authors list together
with the images in any build that ships them.

## Files used

Every sheet is the LPC **`idle`** pose: a 64×64 frame grid, one row per facing in LPC's own order —
**north, west, south, east**. Column 0 is the frame we draw; the extra column some body sheets carry is
a second idle variant we do not use. The `walk` sheets (9 columns) are the same geometry and are what
animation will come from later.

| File | Upstream path | Used for |
| --- | --- | --- |
| `body-human-male.png` | `Body/Base/Human_male/Ivory/idle.png` | The body under every human, player and mob alike |
| `torso-longsleeve-forest.png` | `Clothes/Torso/Human_male/Long-Sleeve Shirt/Forest/idle.png` | The player's shirt |
| `legs-slacks-green.png` | `Clothes/Legs/Human_male/Slacks/Green/idle.png` | The player's trousers |
| `torso-chainmail.png` | `Clothes/Torso/Human_male/Chainmail Shirt/idle.png` | The IceCrag sentry's mail |
| `legs-greaves-silver.png` | `Clothes/Legs/Human_male/Greaves/Silver/idle.png` | The IceCrag sentry's greaves |

## Why layers rather than finished sprites

`CLAUDE.md` names layered LPC equipment as a requirement: worn gear has to be **visible on the
character**, not merely listed beside them. Keeping the body, torso and legs as separate images is what
makes that possible — the stack a character is drawn from is data, so when equipment becomes real
(roadmap Phase 15) the layer list is derived from what they are wearing rather than authored per mob.
Flattening these into one PNG per character would save a few draw calls and throw that away.

## Adding more sets

Drop the PNG in this folder, named `category-name.png` to match the table above, and add a row to it.
`LPC_SHEETS` in `packages/client/src/scene.ts` is the list the loader reads; sheets are loaded as
spritesheets at 64x64, so a sheet must be LPC's own frame geometry.

**Adding art means adding its credits.** CC-BY-SA 3.0 and GPL 3.0 both require attribution, so a new
sheet is not installed until its artist is named in the Authors section above. The upstream per-asset
credit files are the authoritative record and should be quoted rather than paraphrased.

Three good sources:

- **<https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator>** — the
  Universal LPC Spritesheet Generator. It exports a credits file alongside each sheet, which is exactly
  what this folder needs. *(Note: this moved from `sanderfrenken/` to the `LiberatedPixelCup/`
  organisation — older links and blog posts still point at the previous location.)*
- **<https://opengameart.org/>** — the LPC collection and the original competition entries. Check each
  submission's own licence line; the LPC set is CC-BY-SA 3.0 / GPL 3.0 but OpenGameArt hosts other
  terms too.
- **<https://github.com/OpenGameArt/LiberatedPixelCup>** — the official repository, already vendored at
  `assets/lpc-opengameart/` in this project.

Anything LPC does not have gets **drawn to match** rather than borrowed from another style — `CLAUDE.md`
is explicit about one cohesive look. The corpse sprites (a pile of bones, and a single bone once looted)
are generated in `scene.ts` for that reason, and are the first thing here that should be replaced by real
art when a suitable LPC set turns up.

## Shield (Phase 16)

`offhand-shield.png` and `offhand-shield-idle.png` are the **heater shield, wooden face**, from the
**Universal LPC Spritesheet Character Generator** at
<https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator>
(`spritesheets/shield/heater/original/wood/fg/{walk,idle}.png`).

Taken byte-for-byte with no processing: the generator's sheets are the same 576x256 walk / 128x256
idle geometry at 64 px a frame that every garment above uses.

The generator's own per-asset credits are `credits/credits.csv` in that repository, which is the
authoritative record. Shield art there is credited to **bluecarrot16**, with the LPC base by
**Stephen Challener (Redshrike)**. Licensed under **CC-BY-SA 3.0** / **GPL 3.0** / **OGA-BY 3.0** —
the same share-alike terms as everything else in this folder.

The full pack is checked out at `assets/ulpc/` (untracked, ~1.5 GB) and is where the remaining shield
styles — kite, round, scutum, spartan, crusader — and the heraldic `pattern/` overlays live, if a
second shield look is ever wanted. The `fg`/`bg` split in those directories is LPC's own answer to
draw order: `fg` is the half drawn over the body, and it is the only half the walk and idle cycles
need.


## Carried bow and worn quiver (Phase 15's drawn-gear tail)

`weapon-bow-carry.png` and `weapon-bow-carry-front.png` are the **normal bow, walk animation**
(background and foreground layers, `medium` wood) from the same Universal LPC generator, at
`spritesheets/weapon/ranged/bow/normal/walk/{background,foreground}/medium.png` — cropped from 13 to
the 9 real columns (the last four are empty padding, measured) and staged at the sheets' own
**128 px** frame, because a slung bow overhangs a 64 px cell. Credited there to **Johannes Sjölund
(wulax)** with walk animations by **Pierre Vigier (pvigier)**, split into layers by **bluecarrot16**;
licensed **OGA-BY 3.0+ / GPL 3.0 / CC-BY 4.0**
(<https://opengameart.org/content/lpc-walk-animations-for-bows>). The `-shoot` twins beside them are
hand-staged transparent blanks — the swap that hands the archer over to the kit pack's draw
animation without ever showing two bows.

`quiver-quiver.png` and its action twins were already staged by `artgen` from the generator's
`spritesheets/quiver/` — **Johannes Sjölund (wulax)**, **CC-BY-SA 3.0 / GPL 3.0 / OGA-BY 3.0**
(<https://opengameart.org/content/lpc-medieval-fantasy-character-sprites>) — and are now also the
art-class fallback for every catalogue quiver without chosen art.
