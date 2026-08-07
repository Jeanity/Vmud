/**
 * The world renderer.
 *
 * Owns no authoritative state. It draws what the server reports, and predicts the local player's
 * movement between updates using the *same* `stepMovement` the server runs — so prediction and
 * simulation cannot drift apart by design rather than by care.
 */

import Phaser from 'phaser';

import {
  LPC_ART_BY_ID,
  LPC_SHEET_GEOMETRY,
  PLAYER_SPEED,
  ROOM_TILES,
  parseArtId,
  TILE_SIZE,
  Tile,
  buildZoneTilemap,
  describeStance,
  isWalkable,
  normaliseIntent,
  samePlace,
  setDoorTiles,
  stepMovement,
  tileAt,
  type AffectView,
  MAX_LEVEL,
  type Equipped,
  type CarriedLight,
  type Direction,
  type EntityId,
  type EntityView,
  type Place,
  type Posture,
  type RoomId,
  type SelfView,
  type Status,
  type TileGrid,
  type TilePoint,
  type Zone,
  stripColour,
  EQUIP_SLOTS,
  describePurse,
  type BagRow,
  type BagView,
} from '@mygame/shared';

/**
 * Visibility is the *same* implementation the server runs — see `docs/DESIGN-visibility-and-light.md`.
 *
 * Not exported from the package index, so it is imported by path like `pathfind.ts` is.
 */
import {
  DEFAULT_LIGHT_RADIUS,
  bitsFromBase64,
  bitsetAdd,
  bitsetBytes,
  bitsetHas,
  computeVisible,
  createBitset,
} from '@mygame/shared/vision.ts';

/**
 * The light catalogue, for the two things this file needs from it and no more: the ids to generate a
 * ground sprite for, and the room-mode illumination the server also runs.
 *
 * `roomLightTiles` is imported for the same reason `computeVisible` is — a beacon that lights whole
 * rooms server-side and paints a small disc here is a desync you can see. One derivation, both sides.
 *
 * Not exported from the package index, so it is imported by path like `vision.ts` is.
 */
import { LIGHT_SOURCES, naturalLightTiles, roomLightsItself, roomLightTiles } from '@mygame/shared/light.ts';

import type { LogPanel } from './log.ts';
import type { Net } from './net.ts';
import { bagIcon } from './bagicon.ts';
import { artIdForSheet, layerKeysFor, readLayerKey, recolouredSheet, swapsForArt } from './recolour.ts';
import { paint } from './paint.ts';
import { TargetMenu, type TargetVerb } from './targetmenu.ts';

/**
 * Terrain artwork: Liberated Pixel Cup tiles by Sharm and HughSpectrum.
 *
 * Each LPC terrain sheet is a 3x6 transition template. Frame 10 is the blob interior — a flat base
 * colour — and frames 15-17 are the detailed variants (grass tufts, cobbles, water highlights).
 * Detail frames are preferred wherever they exist, because a flat fill reads as a bug.
 *
 * Where LPC has no matching terrain (snow, open sky, the astral plane) an existing tile is tinted
 * instead. Tint multiplies, so it can only darken or colour-shift — never brighten — which is why
 * pale terrain is built from the sandy `dirt` tiles rather than the green ones.
 *
 * See `public/tiles/ATTRIBUTION.md`. Licence is CC-BY-SA 3.0 / GPL 3.0, both share-alike.
 */
interface TileArt {
  readonly sheet: string;
  /**
   * Candidate frames, chosen per tile by position hash. Repeats act as weights — listing the plain
   * base frame three times and detail frames once each gives mostly flat ground with scattered
   * tufts, which is what stops a field reading as one solid block of colour.
   */
  readonly frames: readonly number[];
  readonly tint?: number;
}

export const TILE_SHEETS = [
  'grass', 'grassalt', 'dirt', 'dirt2', 'water', 'watergrass', 'hole', 'rock',
] as const;

/** Indexed by `SECTOR_INDEX` order. */
const SECTOR_ART: readonly TileArt[] = [
  { sheet: 'dirt2', frames: [10, 10, 17] },                    // inside — flagstones
  { sheet: 'dirt', frames: [10, 10, 17], tint: 0xb8b8b8 },     // city — cobbles, greyed
  { sheet: 'dirt', frames: [17, 17, 10] },                     // road
  { sheet: 'grass', frames: [10, 10, 10, 16, 17] },            // field
  { sheet: 'grass', frames: [10, 10, 16, 17, 15], tint: 0x8fb88f }, // forest — denser, darker
  { sheet: 'grass', frames: [10, 10, 15, 16], tint: 0xc8c8a0 },     // hills — drier
  { sheet: 'dirt2', frames: [17, 10], tint: 0xb4b4b4 },        // mountain — grey stone
  { sheet: 'dirt2', frames: [15, 10, 17], tint: 0x9ab08a },    // swamp — murky green
  { sheet: 'dirt', frames: [10, 10, 17], tint: 0xffe0a8 },     // desert — bleached sand
  { sheet: 'dirt', frames: [10, 10, 17], tint: 0xdff0ff },     // arctic — pale blue snow
  { sheet: 'hole', frames: [10] },                             // cave — dark
  { sheet: 'watergrass', frames: [16, 17, 15] },               // shallow water
  { sheet: 'water', frames: [16, 17, 15], tint: 0x8899cc },    // deep water — darker
  { sheet: 'water', frames: [10, 16], tint: 0x6070a0 },        // underwater
  { sheet: 'water', frames: [10], tint: 0xa8d8ff },            // air — pale sky
  { sheet: 'hole', frames: [10], tint: 0xa080d0 },             // astral — violet void
];

const CONNECTOR_ART: TileArt = { sheet: 'dirt', frames: [17, 17, 10] };
/** A **shut** door: solid, and the warm timber tint that says "this is a thing, not a floor". */
const DOOR_ART: TileArt = { sheet: 'dirt2', frames: [15], tint: 0xd0a070 };
/**
 * The same doorway standing open.
 *
 * Still visibly a door rather than reverting to plain corridor — the player needs to see at a glance
 * which openings are doors they have opened, because those are the ones that can be shut again and
 * the ones that were worth a key. Drawn on the corridor's own frames so the ground reads as passable,
 * darkened rather than recoloured so it sits beside the shut tint as the same object in another state.
 */
const OPEN_DOOR_ART: TileArt = { sheet: 'dirt', frames: [17], tint: 0x9a7048 };
/**
 * Stairs, and the two directions are deliberately **not** the same tile.
 *
 * They used to share one grey marker on a single tile, which meant the only way to tell a room had
 * stairs — never mind which way they went — was to read the exit list. Vertical travel is the one
 * movement the map cannot draw as a corridor, because the far side is a different Place, so it has to
 * be a landmark instead: pale worked stone going up toward daylight, a dark hole going down.
 */
const STAIRS_UP_ART: TileArt = { sheet: 'dirt2', frames: [10], tint: 0xe8e4d4 };
const STAIRS_DOWN_ART: TileArt = { sheet: 'hole', frames: [10], tint: 0x8a8f80 };
const FALLBACK_ART: TileArt = { sheet: 'grass', frames: [10] };

/** Divergence from the server, in pixels, past which we stop easing and just snap. */
const SNAP_DISTANCE = 28;

/**
 * Reconciliation rates, as a fraction of the remaining gap per frame at 60fps. See {@link ease} for
 * why they are not applied literally.
 *
 * `EASE_PREDICTED` corrects a local prediction that is already nearly right, so it is gentle.
 * `EASE_FOLLOW` is the only thing moving a sprite the server alone is driving — every remote entity,
 * and the local player during click-to-move — so it has to keep up rather than merely converge.
 */
const EASE_PREDICTED = 0.12;
const EASE_FOLLOW = 0.22;

/**
 * Keys that step through an exit, held with Shift.
 *
 * Free steering can only ever move within one Place: collision runs against the current grid, and
 * `buildZoneTilemap` deliberately carves no corridor for a portal or a staircase. Every exit that
 * changes Place — all 27 cardinal portals and 10 vertical links across the two prototype zones — is
 * therefore reachable *only* by a `move` intent, which is what these send. Without them a character
 * spawning on zone 260's four-room ground level can never leave it.
 *
 * Multiple keys map to one direction (WASD and the arrows both walk), so this is a list rather than
 * a record.
 */
const TRAVEL_KEYS: readonly (readonly [key: string, dir: Direction, needsShift: boolean])[] = [
  // Shift is required on the four compass keys and *only* because they already mean something
  // unmodified: they steer. Shift is what says "step through the exit" rather than "glide that way".
  ['W', 'north', true], ['UP', 'north', true],
  ['S', 'south', true], ['DOWN', 'south', true],
  ['A', 'west', true], ['LEFT', 'west', true],
  ['D', 'east', true], ['RIGHT', 'east', true],
  // Up and down have no unmodified meaning to disambiguate from — there is no way to steer vertically,
  // and there never will be, because a level is a separate Place with its own grid. Demanding a
  // modifier for them was friction with nothing on the other side of it, and it is what made vertical
  // travel feel broken. Shift+Q still works; it is simply not required.
  ['Q', 'up', false], ['E', 'down', false],
];

/**
 * LPC sheets the client loads, and the layer stacks it composes them into.
 *
 * **The server sends an art key and nothing more** — `EntityView.sprite` is `'human'` or `'sentry'`,
 * and how many PNGs that is, drawn in what order, is a rendering question the client owns. That split
 * is why a mob needed no protocol change at all.
 *
 * Every sheet is the LPC `idle` pose: a 64x64 frame grid with **one row per facing, in LPC's own
 * order** — north, west, south, east. Column 0 is the frame drawn; the extra column some body sheets
 * carry is a second idle variant we do not use. `walk.png` is the same geometry at nine columns and is
 * where animation comes from later, which is the reason to key the row off facing now rather than
 * baking four separate textures.
 *
 * Order within a stack is paint order, bottom first: body, then legs, then torso. Get it wrong and the
 * character wears their trousers over their armour. See `public/lpc/ATTRIBUTION.md` for provenance and
 * for why these are separate images rather than one flattened sprite per character.
 */
const LPC_FRAME = 64;

/** How far above a body the target marker floats, in pixels. Clear of the head at this sprite scale. */
const MARKER_HEIGHT = 46;

/**
 * The LPC walk cycle: **columns 0 through 7**, with column 0 the neutral both-feet-down pose that
 * also serves as standing.
 *
 * Phase 15a, owner-reported: *"it looks like the players are ice skating."* They were — every layer
 * was staged from `idle.png` (2 columns) and drawn at column 0 for ever, so a body slid across the
 * floor in a fixed pose. The sheets were re-staged from `walk.png` and the column now advances.
 *
 * **Eight and not nine, which the pack will not tell you.** The `walk.png` sheets are mostly 9
 * columns wide, so a nine-frame cycle looks right — and it is wrong. Measuring the alpha of every
 * frame of all fourteen staged sheets: **seven have a completely empty column 8**, and one (the
 * sleeveless shirt) is physically 8 columns. Column 8 is padding to a common width in half the set,
 * not a frame. Cycling through it made the boots and the cap *vanish* for one frame every eight
 * steps, exposing a bare head and bare feet — owner-reported as "it flashes a box every few steps".
 *
 * So the honest cycle is what every sheet actually has, and column 0 doubles as the rest pose. That
 * costs nothing: in LPC frame 0 is the contact pose with both feet down, which is what standing
 * still should look like anyway.
 */
const WALK_COLUMNS = 8;
const WALK_STANDING_COLUMN = 0;

/**
 * How far a character travels per step frame, in pixels.
 *
 * **Distance, not wall time**, and this is the whole difference between a walk and a moonwalk: tie the
 * cycle to a timer and the feet run at their own rate while the body moves at another, which reads as
 * sliding just as badly as no animation at all. Driving it from distance makes the contact frames land
 * wherever the character actually is, at any speed, including while being eased toward a server
 * correction.
 *
 * `PLAYER_SPEED` is 150 px/s, so 18 px gives about 8 frames a second at a walk — near the cycle's
 * natural cadence without being told what that cadence is.
 */
const WALK_PIXELS_PER_FRAME = 18;

/**
 * How far a body must move in one frame to count as walking rather than settling.
 *
 * Owner-reported: a character who stopped stayed frozen mid-stride. The cause was treating "stopped"
 * as *exactly* zero movement — but a sprite easing toward the server's position approaches it
 * asymptotically and never arrives, so it always has some residue and never qualified as stopped.
 *
 * At `PLAYER_SPEED` a real step is about 2.5 px per frame, so this sits an order of magnitude below
 * a stride and an order above the residue: it cannot mistake one for the other in either direction.
 */
const WALK_MOVING_EPSILON = 0.25;

/**
 * Suffix of the companion sheet a layer stands still on.
 *
 * **The walk sheet has no rest pose in it**, which is not obvious and cost a round of guessing.
 * Measured against the pack's own `idle.png`: the *closest* walk column still differs from the idle
 * frame by 173 pixels, and the cycle turns out to be eight genuine strides — columns 0–3 leading with
 * one leg and 4–7 with the other — so **every** column is mid-stride. Standing on column 0 therefore
 * left a character permanently caught with one foot forward, which shows most when they turn on the
 * spot: the legs snap between two strides and never settle.
 *
 * LPC ships `idle.png` beside `walk.png` for exactly this, so both are loaded and a layer swaps
 * texture rather than column when it stops. That is 14 more sheets and about 250 KB, which is the
 * cheapest correct answer available — the alternative is drawing a rest pose we do not have.
 */
const IDLE_SUFFIX = '-idle';

/* -------------------------------------------------------------------------- */
/* Action poses — protocol 22, the owner's animations ask (2026-08-07)         */
/* -------------------------------------------------------------------------- */

/**
 * The pose suffixes beside `-idle`: staged by `worldgen/src/kit-actions.ts` for the same
 * full-fidelity set the idle twins cover, guarded per layer on `textures.exists` exactly as the
 * idle swap is — a layer without the staged twin holds its walk frame, the contract indexed art
 * has lived under since 15a.
 *
 * Frame counts are **measured, not assumed** (the walk sheet's empty ninth column is this file's
 * founding trauma): the kit pack's swing is 7 real frames, thrust 9, magic 8, hurt 7, none padded.
 */
const ACTION_SUFFIXES = { slash: '-slash', thrust: '-thrust' } as const;
const ACTION_COLUMNS: Readonly<Record<'-slash' | '-thrust', number>> = { '-slash': 7, '-thrust': 9 };
/** ~90 ms a frame lands a slash at ~0.6 s — inside a 2–3 s round, so swings read as distinct events. */
const ACTION_FRAME_MS = 90;
/** The held wind-up loop. Slower than a swing on purpose: a chant is effort, not violence. */
const CAST_SUFFIX = '-spellcast';
const CAST_COLUMNS = 8;
const CAST_FRAME_MS = 140;
/**
 * The down pose — the hurt sheet's final frame, a body flat on the ground. One frame for every
 * non-standing posture (a bash's "knocked to the ground", sleep, rest, the dying window) because
 * the kit pack ships no sit sheet and a body on the ground has no facing worth drawing: `hurt.png`
 * is the one LPC sheet with a single row, so the frame index ignores `LPC_ROW` entirely.
 */
const DOWN_SUFFIX = '-hurt';

/**
 * Sheets that ship a real `idle.png` beside their walk cycle.
 *
 * **"Real" is doing work in that sentence, and it was measured.** The pack's idle sheets are not all
 * complete: every one of these carries all four facings, and `offhand-shield-idle.png` carried
 * **only north and south** — 71 / 0 / 107 / 0 opaque pixels in its first column, by facing. So a
 * character standing still while facing east or west had no shield on them at all, which is exactly
 * what the owner reported (2026-08-05): *"the shield disappears when I stop moving if I am facing any
 * way but south or north."*
 *
 * That is the same class of fault as the empty column 8 this file already documents, and it wants the
 * same answer: **measure the sheet, do not assume it.** Anything not in this list falls through to
 * its walk sheet's own standing frame, which `faceEntity` already does for indexed art.
 */
const LPC_IDLE_SHEETS: readonly string[] = [
  'body-human-male',
  'torso-longsleeve-forest',
  'legs-slacks-green',
  'torso-chainmail',
  'legs-greaves-silver',
  // Phase 15a: the starter kit, one sheet per item the roll can produce. Staged from the LPC pack's
  // own `idle.png` for each garment and colourway — see `KIT_ART` for which is which.
  'torso-tunic-leather',
  'torso-jerkin-padded',
  'torso-vest-quilted',
  'legs-leggings-leather',
  'legs-breeches-wool',
  'feet-shoes-worn',
  'feet-boots-travel',
  'head-cap-leather',
  'head-hood-cloth',
];

/**
 * Sheets loaded for their walk cycle alone — no idle twin, by measurement rather than by omission.
 *
 * A held object has no distinct rest pose anyway: a shield hangs off an arm whether the legs are
 * moving or not, and the walk sheet's own column 0 is the contact pose. So this costs nothing beyond
 * the frame it was already going to draw.
 */
const LPC_WALK_ONLY_SHEETS: readonly string[] = [
  // Phase 16: the first thing a character carries that is actually drawn. LPC's heater shield, taken
  // from the Universal LPC Spritesheet Generator's `shield/heater` at the same 576x256 geometry every
  // garment above uses, so it needed no processing at all.
  'offhand-shield',
];

/**
 * The action twins protocol 22 poses from — swing, chant, down. **These were staged and never
 * loaded**: the animations slice put 56 PNGs in `public/lpc/` and grew no load list, so
 * `poseLayers`' `textures.exists` guard was false forever and every pose silently held the walk
 * frame. The drive read `attackResolved.swing` off the wire and called it done; the owner watched
 * the screen and reported what it actually showed (2026-08-07): *"the legs move but I am not
 * seeing any weapon slashing or arms moving for casting."* The graceful-degradation contract hid
 * the omission by design — a missing sheet is a held frame, not an error — which is exactly why
 * a visual claim needs a visual check.
 *
 * Measured, per this file's own doctrine: all 14 idle-listed sheets carry all four twins (56 = 14
 * × 4, byte-counted on disk); `offhand-shield` carries none — the pack draws no shield motion —
 * and stays walk-only, its held frame being the documented degradation.
 */
const LPC_ACTION_SUFFIXES = ['-slash', '-thrust', '-spellcast', '-hurt'] as const;

const LPC_SHEETS: readonly string[] = [
  ...LPC_IDLE_SHEETS.flatMap((sheet) => [
    sheet,
    sheet + '-idle',
    ...LPC_ACTION_SUFFIXES.map((suffix) => sheet + suffix),
  ]),
  ...LPC_WALK_ONLY_SHEETS,
];

/**
 * Which LPC sheet each wearable item draws as. Phase 15a.
 *
 * **This table is the art direction, and it lives here on purpose.** The server sends *what* is worn
 * as item ids; that a leather tunic is a brown long-sleeve shirt from the LPC pack — and that the art
 * is LPC at all — is the client's business, the same boundary `Actor.sprite` has always had. Putting
 * sheet names on the wire would make a re-skin a protocol change.
 *
 * An item with no entry simply does not draw. That is the honest default for a slot the pack has no
 * art for: LPC ships exactly one hand garment (Gauntlets) and nothing resembling frayed wraps, so
 * hands are unlayered rather than drawn as something they are not.
 */
/**
 * The **starter kit's** art, and nothing else's — what used to be `ITEM_LAYER`.
 *
 * A7b retired this as *the* mechanism. It was ten hardcoded rows mapping an id to a sheet, which could
 * hold neither the 16,421-entry catalogue nor anything an operator authored; art is now an item's own
 * `art` field, indexed by `artgen` into `LPC_ART`, and {@link WorldScene.sheetFor} looks there first.
 *
 * What is left is the nine ids `equipment.ts` invents for the authored starter kit. Those are not
 * catalogue items and have no template to carry an `art` field, so their mapping genuinely does live
 * on the client — and `shield` stays as protocol 14's art *class*, the fallback for 419 catalogue
 * shields that nobody has chosen a sheet for yet.
 */
const KIT_ART: Readonly<Record<string, string>> = {
  leather_tunic: 'torso-tunic-leather',
  padded_jerkin: 'torso-jerkin-padded',
  quilted_vest: 'torso-vest-quilted',
  leather_leggings: 'legs-leggings-leather',
  rough_breeches: 'legs-breeches-wool',
  worn_shoes: 'feet-shoes-worn',
  travel_boots: 'feet-boots-travel',
  leather_cap: 'head-cap-leather',
  cloth_hood: 'head-hood-cloth',
  shield: 'offhand-shield',
};

/**
 * Painter's order for the body. Feet before legs before torso before head, because that is the order
 * a person dresses and the order the overlaps have to resolve: a boot cuff sits under a trouser leg,
 * a trouser waist under a shirt hem, a hood over everything.
 *
 * **`offHand` is last, because a shield is held in front of the body.** LPC ships shields as a
 * foreground layer for the walk and idle cycles — the artist has already drawn each facing correctly,
 * including the one where the arm is on the far side — so it goes over everything rather than needing
 * a per-facing rule of our own.
 *
 * `mainHand` is still absent. The pack's weapon art is **attack animations only** — Swing, Thrust and
 * Shoot sheets — with no idle-hold frame, and our characters are drawn from the walk/idle rows.
 * Drawing a dagger would need either an attack animation the combat system does not have (a swing is a
 * log line today, not a motion) or custom art. Recorded rather than bodged: see Phase 16.
 */
/**
 * Draw order for the **starter kit**, on the same scale as ULPC's own `zPos`.
 *
 * What used to be `LAYER_ORDER`, a list of slots in painting order — feet before legs before chest
 * before head, because that is the order a person dresses and the order the overlaps have to resolve:
 * a boot cuff under a trouser leg, a trouser waist under a shirt hem, a hood over everything.
 *
 * It is a *fallback* now rather than the mechanism. Indexed art carries the z its artist gave it, so
 * this covers only the nine ids `equipment.ts` invents, which have no index entry. The numbers are
 * ULPC's for the equivalent garment, so kit and indexed art interleave correctly on one body.
 */
const KIT_Z: Readonly<Record<string, number>> = {
  feet: 25,
  legs: 30,
  chest: 35,
  arms: 40,
  hands: 45,
  waist: 50,
  about: 55,
  head: 60,
  back: 15,
  // A held thing goes over the body it is held in front of. ULPC puts its own weapons at 140.
  offHand: 135,
  mainHand: 140,
};

const SPRITE_LAYERS: Readonly<Record<string, readonly string[]>> = {
  /** Every player. Phase 15 derives this list from what they are wearing instead of naming it here. */
  human: ['body-human-male', 'legs-slacks-green', 'torso-longsleeve-forest'],
  /** The IceCrag sentry: the same body, in mail and greaves. */
  sentry: ['body-human-male', 'legs-greaves-silver', 'torso-chainmail'],
};

/**
 * Which sheet row a facing draws from — LPC's row order, which is not the same as ours.
 *
 * `DIRECTIONS` is Diku's north/east/south/west; LPC's sheets are north/west/south/east. Writing the
 * mapping out is the whole defence against that: the two orders differ only in the second and fourth
 * entries, so an off-by-one here produces a character who faces left when they walk right, which looks
 * like a bug in the movement code rather than in a lookup table.
 *
 * Vertical travel has no sheet row of its own. `up` and `down` keep the south-facing frame, which is
 * what the character was already drawn as while standing on a staircase.
 */
const LPC_ROW: Readonly<Record<Direction, number>> = {
  north: 0,
  west: 1,
  south: 2,
  east: 3,
  up: 2,
  down: 2,
};

/**
 * How far up to shift an LPC sprite so its feet land on the tile it occupies.
 *
 * An LPC frame is 64 tall and the figure stands on about its last row of pixels, while an entity's
 * container is positioned at the character's *feet* — that is what collision and `roomAtTile` both mean
 * by a position. Centring the image on that point would bury the body half underground, so it is lifted
 * by not quite half a frame. Measured against the 32px tile rather than derived: the LPC figure does not
 * fill its frame, and the number that matters is where the boots are.
 */
const LPC_FOOT_OFFSET = -22;

/**
 * Movement keys, for the "the player has taken the wheel" edge.
 *
 * Pressing any of these abandons a server-walked path. Deliberately just the steering keys: `Q`/`E`
 * only do anything with Shift held, and those presses already arrive here as a travel intent.
 */
const MOVEMENT_KEYS: readonly string[] = ['W', 'A', 'S', 'D', 'UP', 'LEFT', 'DOWN', 'RIGHT'];

/**
 * DOM panels drawn **over the canvas**, which a world click must therefore be tested against.
 *
 * Both are `pointer-events: none` so a click passes straight through to the canvas, and Phaser then
 * reports it as a click on the world — which would walk the character every time the player glanced
 * at their own health. This list is what stops that, and it matters more for `#status` than it did for
 * the room label it replaced: the vitals are the thing a player looks at most, so they are the thing
 * they would most often click by accident.
 *
 * It is two entries rather than four because the log and the character sheet are no longer *over* the
 * map: they are grid columns beside it, so the canvas ends where they begin and a click on either
 * cannot reach Phaser at all. That is the quiet win in the three-column layout — a whole class of
 * click-through bug stopped being possible instead of being guarded against.
 */
const UI_PANELS: readonly string[] = ['status', 'hint', 'target-menu', 'announce'];

/**
 * How close a click has to land to count as clicking a body, in world units.
 *
 * A tile and a half. Generous on purpose: the sprites are 64px tall but only occupy the lower part of
 * their frame, and asking a player to hit a 20-pixel collision box on a moving target is asking them
 * to miss. Overlapping candidates are broken by distance, so generosity costs nothing but reach.
 */
const CLICK_REACH = TILE_SIZE * 1.5;

/**
 * The zoom ladder, closest first. `'fit'` frames the whole Place and is a property of the map rather
 * than a ratio, so it is computed in {@link WorldScene.frameCamera} instead of listed here.
 *
 * Discrete on purpose. The game runs `pixelArt: true`, so every texture uses NEAREST filtering; at a
 * fractional scale a 32px tile samples unevenly and the whole map shimmers and crawls as the camera
 * moves. Only these exact ratios are ever rested on — the tween between two of them is transient and
 * short enough that the crawl never becomes visible.
 */
const ZOOM_STEPS = [2, 1, 0.5, 0.25, 0.125] as const;

/**
 * `'fit'` — the whole Place on screen — is deliberately **not** on the wheel ladder.
 *
 * It is a different mode, not another rung: it stops following the character and centres the map
 * instead. Reaching it by wheeling meant the last notch silently changed what the camera was doing,
 * which is what made zooming out lurch. It lives on <kbd>M</kbd>, where re-framing is obviously what
 * was asked for.
 */
type ZoomStep = (typeof ZOOM_STEPS)[number] | 'fit';

/**
 * Index of `0.5` — half a screen pixel per texture pixel, so a room and its neighbours fit at once.
 *
 * Was the index of `1`, which is the sharpest honest rung (one screen pixel per texture pixel) and too
 * close to play at: a 9x9 room filled the view and the doorway you were walking towards was off screen.
 * 0.5 is still an exact power of two, which the `pixelArt` NEAREST filtering requires — see
 * {@link ZOOM_STEPS} — so it is a change of default and not a change of what the ladder may rest on.
 */
const ZOOM_DEFAULT_STEP = 2;
const ZOOM_MS = 150;
const ZOOM_EASE = 'Quad.easeInOut';

/**
 * Route drawing.
 *
 * Above the map (0) and its labels (1) but below the fog overlay (50): a route across ground the
 * character merely remembers should still look dimmed. It can never cross ground they have not seen
 * at all, because the server refuses to path there.
 */
const PATH_DEPTH = 5;

/** Above the bodies and the path line both — a marker hidden behind a sprite marks nothing. */
const DEPTH_MARKER = 15;

/* -------------------------------------------------------------------------- */
/* V3 — speech in the world                                                    */
/* -------------------------------------------------------------------------- */

/**
 * **Above the fog, not merely above the bodies** — owner's rule, 2026-08-05: *"the bubble should be
 * fully visible even in the dark. darkness doesn't affect what can be heard."*
 *
 * That is a real distinction and the first draft got it wrong. The fog overlay is one image at depth
 * 50 covering the whole Place, and a bubble underneath it is dimmed by however dark the tiles behind
 * the *text* happen to be — which is usually the unlit air above the speaker's head, not the speaker.
 * So a perfectly visible person's words faded out because of the ceiling.
 *
 * **Being drawn at all is still gated on sight, and that gate is elsewhere and unchanged**: the bubble
 * is attached to an entity the client holds, and a speaker outside your light is not one. So the rule
 * is exactly *"if you can see who is talking, you can read what they said"* — darkness decides the
 * first half, and nothing dims the second.
 *
 * A **silenced room** is the case that would stop a line being heard at all, and that is a server-side
 * rule about who receives the message rather than a rendering one; there is no such flag yet.
 */
const DEPTH_SPEECH = 60;
/** Clear of the target chevron, which already sits at {@link MARKER_HEIGHT}. */
const SPEECH_HEIGHT = MARKER_HEIGHT + 16;
/** Wrapped rather than let run: a long sentence over one body must not cover the room. */
const SPEECH_WRAP_PX = 150;
/**
 * How long a bubble stays up.
 *
 * **Scaled by how much there is to read**, because a fixed dwell is wrong at both ends: two seconds
 * is an age for *"hi"* and not enough for a sentence. Roughly 190 ms a word at a comfortable reading
 * pace, on a floor that keeps a one-word greeting on screen long enough to notice at all.
 */
const SPEECH_MIN_MS = 2200;
const SPEECH_MS_PER_CHAR = 45;
const SPEECH_MAX_MS = 9000;
const PATH_COLOUR = 0xffe9a8;
/** Matches the log's error colour, so a refusal reads the same in both places. */
const DENIED_COLOUR = 0xd08a7d;
const DENIED_MS = 420;

/**
 * Hold-to-drag: a virtual joystick, **not** a route.
 *
 * Holding the button walks the character in a straight line toward the pointer, wherever it is — lit
 * or unlit, one tile away or across the map. Moving the pointer changes the heading immediately.
 * There is no pathfinding and no routing round corners: a wall in the way means the character does
 * not get there, and the player moves the pointer somewhere reachable. See
 * `docs/DESIGN-visibility-and-light.md` §5.
 *
 * **This is deliberately not fog-gated, and clicking still is.** Steering has never been gated —
 * WASD already walks into the dark. The anti-speedrun rule is about *pathfinding*, which hands a
 * player instant traversal of a known route without walking it; steering earns every tile at walking
 * pace and cannot route round anything it cannot see. Hold inherits the keyboard's rules, not
 * click-to-move's, because it is the same verb.
 *
 * It therefore needs no protocol of its own: it produces exactly the `steer` a held key produces, and
 * the simulation cannot tell the two apart.
 */

/**
 * How long the button must be held before a press stops being a click and becomes a joystick.
 *
 * The click fires on *press*, so a tap keeps its current zero-latency behaviour and this threshold
 * costs it nothing. Long enough not to trip on an ordinary click, short enough that a deliberate
 * hold does not feel dead before it takes.
 */
const DRAG_HOLD_MS = 150;

/**
 * Resolution the joystick heading is rounded to, as a divisor.
 *
 * The heading comes out of a float subtraction between two world positions, so a pointer held dead
 * still on a character walking dead west still produces a `y` that flickers in its last bits. The
 * intent is only transmitted when it *changes*, and unrounded that test is true on every frame:
 * measured, a two-second hold sent 127 identical `steer` messages instead of one.
 *
 * 1/100 is about 0.6° of heading — far finer than anyone can hold a mouse, and coarse enough that
 * jitter never crosses it. Rounding can push a diagonal's magnitude to 1.004, which does not matter:
 * the server normalises every intent it receives, precisely so a client cannot ask for extra speed.
 */
const DRAG_HEADING_STEPS = 100;

/**
 * Minimum gap between refusal flashes while a drag is in progress.
 *
 * A single click flashes every time it is refused, as it always has. A *drag* across unseen ground
 * is refused continuously, and at {@link DRAG_REPATH_MS} that stacks three overlapping rings inside
 * one {@link DENIED_MS} fade — which reads as a fault rather than as feedback. Longer than the fade,
 * so at most one ring is ever alive: the refusal becomes a slow pulse under the cursor.
 */
const DENIED_DRAG_MS = 520;

/*
 * There is deliberately no table of refusal wordings here.
 *
 * The server sends a `log` line with every `pathFailed`, phrased from the reason its own search
 * produced, and this client keeping a parallel table meant one refused click printed two sentences —
 * "You do not know a way there." from here and "You cannot see that far..." from there. Whichever
 * wording is better, having both is worse than either, and the server is the side that knows.
 * `pathFailed` remains useful to this client for the one thing the server cannot do: flash the spot
 * on screen where the pointer actually was.
 */

/**
 * Fog of war. Alpha of the black overlay in each of the three states of the design doc.
 *
 * `unknown` is never-seen ground, `remembered` is terrain this character has seen but is not lighting
 * right now, and `lit` is inside the light radius and in line of sight this instant.
 */
const FOG_UNKNOWN = 255;
const FOG_LIT = 0;

/**
 * How dark remembered ground is, as the alpha of the black overlay over it. Higher is darker.
 *
 * Not a constant: it is driven by the brightness slider, because the right value is a matter of
 * taste and of the monitor it is being looked at on. The stored setting is a *brightness percentage*
 * rather than this alpha, so the control keeps its meaning if the fog is ever retuned.
 *
 * The default is 107, which is 58% brightness — half again the 39% this shipped at, which read as
 * murky.
 */
const REMEMBERED_BRIGHTNESS_DEFAULT = 58;
const REMEMBERED_BRIGHTNESS_MIN = 15;
const REMEMBERED_BRIGHTNESS_MAX = 85;
const BRIGHTNESS_STORAGE_KEY = 'mygame.mapBrightness';

/** Whether the key reference is folded away. Remembered, because dismissing it every reload is worse. */
const HINT_STORAGE_KEY = 'mygame.hintCollapsed';

/** Whether the character sheet was left collapsed. Shown by default — it is where your health is. */
const SHEET_STORAGE_KEY = 'mygame.sheetCollapsed';

/**
 * The equipment slots, and the ids of the cells that draw them.
 *
 * `DESIGN-inventory.md` §6 exactly: head, neck, chest, legs, feet, hands, main hand, off hand, back and
 * two rings. That set is not arbitrary — it is the one that maps onto LPC's layered sprite system,
 * which is what will make worn gear visible *on the character* rather than merely listed here, and the
 * art direction in `CLAUDE.md` names that as a requirement.
 *
 * Note what is **not** in it: a light slot. A dedicated one would be free light forever; instead any
 * equipped item may emit light and the radius is the best among them, which is what makes a torch cost
 * you a hand and a glowing amulet a real power spike at the same radius.
 */
/**
 * The slots the paper doll has a cell for — the body's major places, laid out around the figure.
 *
 * **Not the full list any more.** Phase 16 took the slot set to Duris' own twenty-four, and a doll with
 * twenty-four cells around a silhouette is a spreadsheet rather than a body. The rest render as a
 * compact line underneath, and only when something is actually in them: an eyepatch is a rare find and
 * should read as one, not as a permanently empty box.
 */
const DOLL_SLOTS = [
  'head',
  'neck',
  'back',
  'chest',
  'mainHand',
  'hands',
  'legs',
  'offHand',
  'ring1',
  'feet',
  'ring2',
] as const;

/**
 * Every slot, in the shared list's own order — **imported rather than copied**.
 *
 * The client used to keep its own array of eleven, which was fine while the two agreed and became a
 * silent bug the moment Phase 16 added thirteen: a slot the server can fill and the sheet never reads
 * is a piece of gear that vanishes from the player's view. One list, one order.
 */
const EQUIPMENT_SLOTS = EQUIP_SLOTS;

/** How each of the extra slots reads on the sheet. Duris' paired positions get a side rather than a number. */
const SLOT_LABEL: Readonly<Record<string, string>> = {
  eyes: 'eyes',
  face: 'face',
  nose: 'nose',
  ear1: 'right ear',
  ear2: 'left ear',
  neck2: 'neck',
  about: 'about',
  arms: 'arms',
  wrist1: 'right wrist',
  wrist2: 'left wrist',
  waist: 'waist',
  quiver: 'quiver',
  ioun: 'ioun stone',
};

/** Brightness percentage -> overlay alpha. 100% would be no overlay at all. */
function brightnessToAlpha(percent: number): number {
  const clamped = Math.min(REMEMBERED_BRIGHTNESS_MAX, Math.max(REMEMBERED_BRIGHTNESS_MIN, percent));
  return Math.round(FOG_UNKNOWN * (1 - clamped / 100));
}

/**
 * Blur radius applied at *tile* resolution before the overlay is scaled up.
 *
 * The fog canvas is one pixel per tile, so a 1.1px blur becomes roughly a 35px feather on screen.
 * Blurring small and scaling up is far cheaper than blurring a 3072x3456 overlay, and linear
 * filtering during the upscale does most of the smoothing for free.
 *
 * It matters more now than it did under room-granular fog: the lit set is a *round* disc a few tiles
 * across, so the feather is what makes it read as torchlight falling off rather than as a stencil.
 */
const FOG_BLUR = 1.1;

/**
 * Display depths above the map.
 *
 * Items sit *below* characters so a torch lying on the floor cannot hide the creature standing over
 * it — which is exactly the moment you most need to see the creature. Both are far below the fog
 * overlay at 50, so neither is drawn through darkness.
 */
/**
 * The health bar over another body's head.
 *
 * `EntityView.healthFraction` has been on the wire since Phase 7 and nothing read it until Phase 11 —
 * so "a health bar drops" was true of the protocol and false of the screen. Sized to sit inside one
 * tile so a room of nine servants does not become a wall of bars, and placed above the head rather than
 * under the feet so it cannot be mistaken for the click-to-move marker on the floor.
 *
 * The colours are a health *ramp* rather than one bar that shrinks: green down to amber down to red is
 * the fastest thing to read at a glance in a room with several fights in it, and it does not depend on
 * comparing lengths between two bars of different creatures.
 */
const HEALTH_BAR_WIDTH = 26;
const HEALTH_BAR_HEIGHT = 3;
const HEALTH_BAR_Y = -40;
const HEALTH_FULL = 0x7bb661;
const HEALTH_HURT = 0xd6a740;
const HEALTH_LOW = 0xc4553f;
/** Below this the bar reads as hurt, and below the second as in trouble. */
const HEALTH_HURT_BELOW = 0.6;
const HEALTH_LOW_BELOW = 0.3;

const ENTITY_DEPTH = 10;
const ITEM_DEPTH = 8;

/** Prefix for the generated ground-item textures. See {@link WorldScene.makeItemTextures}. */
const ITEM_TEXTURE_PREFIX = 'item:';
/** Drawn for an item whose sprite key names nothing this client knows how to draw. */
const ITEM_TEXTURE_FALLBACK = `${ITEM_TEXTURE_PREFIX}unknown`;

/**
 * How a carried light's remaining time is coloured, in milliseconds left.
 *
 * The design doc is explicit that a light going out must announce itself — *"a light radius silently
 * shrinking mid-fight in a dark zone is the kind of thing that reads as a bug rather than a
 * mechanic"*. The server says so in the log at the moment it happens; this is the half that gives
 * warning *before* it does, so the drop is something the player walked into rather than something
 * that happened to them.
 *
 * 15 s is about six room crossings at `PLAYER_SPEED` — enough to turn back. 5 s is not enough to do
 * anything except brace, which is why it is styled as an alarm rather than as information.
 */
const LIGHT_WARN_MS = 15_000;
const LIGHT_URGENT_MS = 5_000;

interface FrameOptions {
  /** Ease to the new framing instead of cutting to it. */
  readonly animate?: boolean;
}

interface Entity {
  view: EntityView;
  container: Phaser.GameObjects.Container;
  /**
   * The LPC layers this body is drawn from, bottom first. Empty for a ground item, which is one image
   * and has no facing.
   *
   * Held so a change of facing can re-frame every layer together: they all share the sheet geometry, so
   * the same row index applies to each, and a stack that re-framed only some of them would put a
   * north-facing head on a south-facing body.
   */
  layers: readonly Phaser.GameObjects.Image[];
  /** The "this one is you" ring on the ground. Only the local player has one — the art shows facing by itself. */
  footprint: Phaser.GameObjects.Ellipse | undefined;
  /**
   * The health bar's filled portion, or nothing for a ground item and for yourself.
   *
   * Yourself is excluded because the vitals overlay above the map already carries your own pools in
   * numbers, and a second, coarser copy of the same fact floating over your head is noise. Everyone
   * *else* has no other way to be read.
   */
  health: Phaser.GameObjects.Rectangle | undefined;
  /** The bar's dark backing. Shown and hidden with the fill, or an untouched mob wears an empty trough. */
  healthTrough: Phaser.GameObjects.Rectangle | undefined;
  /**
   * The idle animation, held so it can be stopped when the entity is destroyed.
   *
   * Phaser does not kill a tween when its target dies, and a ground item's bob is `repeat: -1` — so
   * without this every torch ever seen would leave a tween writing to a freed object forever.
   */
  idle: Phaser.Tweens.Tween | undefined;
  /** Rendered position. For the local player this is the prediction. */
  x: number;
  y: number;
  /**
   * Ground covered since this body appeared, in pixels — the walk cycle's clock.
   *
   * Accumulated rather than derived from speed because the two sources of motion (local prediction
   * and easing toward the server) produce different per-frame deltas, and the cycle has to follow
   * whichever is actually moving the sprite. A body that has not moved keeps its total and stands.
   */
  walked: number;
  /** Latest authoritative position. */
  serverX: number;
  serverY: number;
  /**
   * A one-shot motion in flight — protocol 22. Set by an `attackResolved` carrying `swing`, expired
   * by the update loop when its last frame has shown, at which point the very next `faceEntity`
   * rederives the pose from what remains true (casting, posture, walking) — there is no transition
   * to manage because pose was always rederived, never stored.
   */
  action?: { readonly suffix: '-slash' | '-thrust'; readonly startedAt: number };
}

export class WorldScene extends Phaser.Scene {
  private readonly net: Net;
  private readonly log: LogPanel;
  /**
   * Every portal on the current level, for hit-testing a click.
   *
   * Rebuilt with the tilemap and thrown away with it: a portal is part of a level's geometry and none
   * of it survives leaving the Place.
   */
  private portals: { dir: Direction; roomId: RoomId; x: number; y: number }[] = [];

  /** Click a body, get its verbs. Constructed lazily in `create`, once the DOM is certain to exist. */
  private targetMenu!: TargetMenu;

  private grid: TileGrid | undefined;
  private selfId: EntityId | undefined;

  private readonly entities = new Map<EntityId, Entity>();
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  /**
   * True while the caret is in the command line, and the game is therefore deaf to the keyboard.
   *
   * Without this, typing `west` walks you west while it also sends the command — Phaser binds its
   * listeners to the document and has no idea a keystroke was aimed at an input. It has to gate
   * {@link down} rather than only the movement branch, because the single-key handlers (`M`, `O`,
   * `C`, backquote) are separate listeners that would each need remembering; one gate on the read
   * and an early return in the handlers is the whole of it.
   */
  private typing = false;
  /**
   * Whether the server would let this character move — mirrored from `SelfView`, never inferred.
   *
   * Prediction has to respect it. A client that predicted a walk the server refuses produces a sprite
   * that slides away and is snapped back every frame for as long as the key is held, which reads as
   * the connection being broken rather than as the character being sat down. The authority is
   * `Simulation.canMove`; this is a copy of its answer, which is the only thing a client may hold.
   */
  private canMovePredicted = true;
  private lastIntentX = 0;
  private lastIntentY = 0;
  /**
   * Forces the next frame to transmit the steering intent even if it has not changed.
   *
   * Steering is normally sent on change only. But the server zeroes a player's intent whenever it
   * relocates them — held input from the old map would otherwise push them into a wall on the new
   * one — so after any arrival, and after a reconnect, the two sides disagree: the client still
   * believes it has already sent the direction being held. It would then predict movement it never
   * asked for, drift past `SNAP_DISTANCE` and rubber-band on the spot until the key was released.
   */
  private resendIntent = true;
  /**
   * True while a movement key is held.
   *
   * Grabbing the keyboard has to abandon whatever route the server is walking us along, but only on
   * the press edge: a `stop` every frame a key is held would be a hundred messages a second saying
   * the same thing.
   */
  private manualControl = false;

  /** Index into {@link ZOOM_STEPS}. Retained while `fitMode` is on, so M returns to it. */
  private zoomStep = ZOOM_DEFAULT_STEP;
  /** Whole-map overview, toggled by <kbd>M</kbd>. Not a rung of the wheel ladder — see {@link ZoomStep}. */
  private fitMode = false;
  /**
   * V4's graph of Places, toggled by <kbd>Shift</kbd>+<kbd>M</kbd>.
   *
   * Held rather than constructed here because it is plain DOM with no dependency on the renderer, and
   * because `main.ts` is where the socket fan-out lives — the scene owns only the *key*, which is the
   * one part that has to be gated on whether the caret is in the command line.
   */
  private placeMap: { toggle(): void; hide(): void; readonly isOpen: boolean } | undefined;
  /**
   * V5's arrival caption. Injected like {@link placeMap} and for the same reason: it is plain DOM
   * built in , and the scene is only the thing that knows an arrival happened.
   */
  private arrival: { show(zoneName: string, level: number, levels: number): void } | undefined;
  /**
   * What the camera is following, mirrored because Phaser exposes no public accessor for it.
   *
   * Needed because `startFollow` hard-sets the scroll: calling it while already following is a jump
   * cut, so it must only be called when the follow is actually being (re)established.
   */
  private followTarget: Phaser.GameObjects.GameObject | undefined;
  /** This Place's room labels, held so zoom can hide them without rebuilding ~90 text canvases. */
  private roomLabels: Phaser.GameObjects.Text[] = [];

  /** The route the server says it is walking us along. Drawn here, never computed here. */
  private pathLine: Phaser.GameObjects.Graphics | undefined;
  private pathMarker: Phaser.GameObjects.Arc | undefined;
  /** World pixels of the last click, so a refusal can be flashed where it was asked for. */
  private lastClick: { readonly x: number; readonly y: number } | undefined;
  /**
   * Whether the server says it is currently walking us along a route.
   *
   * While it is, the route *replaces* the steer vector server-side rather than blending with it, so
   * a movement key held across the click is being ignored over there. Predicting it here anyway sent
   * the sprite off in a direction the character was not moving, past `SNAP_DISTANCE` within about a
   * fifth of a second, and left it rubber-banding every frame until the key was released — with
   * nothing on screen to say why. Mirrored from the `path` message rather than guessed at: the
   * server is the only thing that knows.
   */
  private serverWalking = false;

  /**
   * Every tile of the *current Place* this character has ever seen, as a bitset over tile indices.
   *
   * Server-owned: replaced wholesale by `seen` on arrival and extended by `seenDelta` as the
   * character moves. Deliberately never accumulated here from {@link visible} — this client's
   * position is a prediction, so a locally derived copy would drift from the server's by a tile here
   * and there, and the server's is the one that decides where a click may path to. A map that
   * disagrees with the pathfinder about which ground is walkable is worse than no map.
   */
  private seen: Uint8Array | undefined;
  /**
   * The last `seen` message, kept rather than consumed.
   *
   * `zone` and `seen` are two messages and nothing here may assume an order between them: the bitset
   * only becomes meaningful once a grid of the matching Place exists to size and index it against.
   * Holding the raw base64 lets either order arrive at the same result.
   */
  private seenSnapshot: { readonly place: Place; readonly bits: string } | undefined;
  /**
   * Tiles lit *right now* — inside the light radius and in line of sight.
   *
   * Transient and purely cosmetic, recomputed locally whenever the predicted position crosses a tile
   * boundary. Never folded into {@link seen}; conflating the two is the way this whole model goes
   * wrong.
   */
  private visible: ReadonlySet<number> = new Set();
  /** The tile {@link visible} was computed from. `undefined` forces a recompute next frame. */
  private visibleTx: number | undefined;
  private visibleTy: number | undefined;
  /**
   * The room {@link visible} was computed from under a `'rooms'`-mode light, `undefined` otherwise.
   *
   * Part of the cache key rather than a separate one: it is what makes a mode change, and a room
   * change under a beacon, both force a recompute, without a second early-return to keep in step.
   */
  private visibleRoom: RoomId | undefined;
  /**
   * The room the natural-light half of {@link visible} was computed for.
   *
   * Separate from {@link visibleRoom}, which is the *beacon* key and is undefined whenever no beacon is
   * carried — natural light applies with any light or none, so it needs a key of its own.
   */
  private visibleNaturalRoom: RoomId | undefined;
  /**
   * How far this character can see, in tiles, straight off `SelfView`.
   *
   * A derived stat rather than a constant: it is the best active light source, so it rises when a
   * torch is picked up and falls again when one burns out. Nothing in this file may hardcode it —
   * {@link DEFAULT_LIGHT_RADIUS} is only the value to hold before the first `self` message lands.
   */
  private lightRadius = DEFAULT_LIGHT_RADIUS;
  /**
   * What is *producing* that radius, straight off `SelfView.light`. `undefined` is the bare eye.
   *
   * Two things read it. The HUD says what you are carrying and how long it has left, and
   * {@link refreshVisible} branches on `mode`: a `'rooms'` source is illuminating at room
   * granularity through the room graph, and painting it as a disc of {@link lightRadius} tiles would
   * show a small circle where the server has lit whole rooms.
   */
  private carriedLight: CarriedLight | undefined;
  /**
   * Scene-clock time at which the carried light burns out, or `undefined` if it never does.
   *
   * A deadline rather than a countdown, because the wire carries `remainingMs` at the instant the
   * `self` message was built and the HUD has to keep counting between them — the server is not going
   * to resend it sixty times a second, and a clock that only moved when a message arrived would sit
   * frozen and then jump. Recomputed from scratch on every `self`, so the server stays the authority
   * on the number and this is only interpolation between its answers.
   */
  private lightDeadline: number | undefined;
  /** What the light HUD currently says, so the DOM is written on change rather than per frame. */
  private lightHudKey: string | undefined;
  /**
   * The timed effects on this character, each with a scene-clock deadline rather than a duration.
   *
   * Deadlines for exactly the reason {@link lightDeadline} is one: `remainingMs` on the wire is true at
   * the instant the message was built, and a HUD that only moved when a message arrived would sit
   * frozen and then jump. The server is the authority and every `self` overwrites the whole list, so
   * this is interpolation between its answers and never a second opinion.
   *
   * `undefined` in `endsAt` means an effect that does not expire — no clock, just a name.
   */
  private affects: readonly { readonly type: string; readonly name: string; readonly endsAt: number | undefined }[] = [];
  /** What the affects panel currently says, so the DOM is written on change rather than per frame. */
  private affectsHudKey: string | undefined;

  /**
   * The room the server says this character is standing in.
   *
   * Only `'rooms'`-mode light needs it, and it takes the *server's* answer rather than deriving one
   * from the predicted position on purpose: `roomLightTiles` keys the whole lit set off this single
   * id, so a client that disagreed by one room would light a completely different block of the map.
   * The server holds a character in their last real room while they are between two (`sim.ts` only
   * reassigns when `roomAtTile` names a room), and this mirrors that rather than reimplementing it.
   */
  private selfRoomId: RoomId | undefined;
  /** The Place's world data, kept for {@link roomLightTiles}, which walks the room graph. */
  private zone: Zone | undefined;

  /**
   * The pointer panning the camera, and where it was last frame.
   *
   * Panning is a **secondary-button** gesture, and it has to be: the left button is already the
   * joystick (see {@link DRAG_HOLD_MS}), and a left-drag that panned instead of steering would take
   * away the movement control the game is built around. Right and middle both work, because a
   * right-drag is awkward on a trackpad and a middle-drag is impossible on some mice.
   */
  private panPointer: Phaser.Input.Pointer | undefined;
  private panLastX = 0;
  private panLastY = 0;

  /* ---- hold-to-drag. See DRAG_HOLD_MS. ---- */

  /** The held pointer, while one is being dragged. `undefined` means no drag is in progress. */
  private dragPointer: Phaser.Input.Pointer | undefined;
  /** Scene-clock time of the press, for the {@link DRAG_HOLD_MS} click-versus-hold threshold. */
  private dragPressedAt = 0;
  /** True once the press has been held long enough to be steering rather than a click. */
  private dragSteering = false;
  /**
   * The heading the joystick is asking for, normalised. Fed into the same intent as the keyboard
   * rather than sent as its own `steer`, so prediction, facing and the resend rule all apply to it
   * unchanged — there is exactly one place that decides where this character is trying to go.
   */
  private dragIntentX = 0;
  private dragIntentY = 0;
  /** Scene-clock time of the last refusal flash, for {@link DENIED_DRAG_MS}. */
  private deniedFlashAt = Number.NEGATIVE_INFINITY;

  private fogTexture: Phaser.Textures.CanvasTexture | undefined;
  private fogBuffer: ImageData | undefined;
  private fogScratch: HTMLCanvasElement | undefined;

  /** Overlay alpha over remembered ground. Driven by the brightness slider. */
  private rememberedAlpha = brightnessToAlpha(REMEMBERED_BRIGHTNESS_DEFAULT);
  /**
   * Something changed that the fog is painted from. See {@link invalidateFog}.
   *
   * The overlay is repainted from this flag once per frame at most, and only on the frames it says
   * so. Painting it every frame would be 26,000 pixels, a blur and a texture upload per frame for a
   * picture that changes about five times a second; painting it on every message that touches it
   * would do the work twice whenever a `seenDelta` and a tile crossing land together.
   */
  private fogDirty = false;

  /** The map currently drawn. `undefined` until the first `zone` message of a connection. */
  private place: Place | undefined;
  /**
   * Set while waiting for the first authoritative position after a Place change. Arriving is a
   * teleport, not movement, so the local player is snapped rather than interpolated — otherwise it
   * slides across a map it was never on, dragging the camera with it.
   */
  private pendingArrival = false;
  /**
   * Everything `buildZone` adds to the display list for one Place: the map texture, the room labels
   * and the fog image. Held so the next Place can destroy them individually.
   *
   * `this.children.removeAll(true)` cannot do this job — its boolean is Phaser's *skipCallback*,
   * not a destroy flag, so it detaches objects without freeing them. That leaked the map's render
   * texture (tens of MB of GPU memory) and ~90 label canvases on every rebuild, which only mattered
   * on reconnect before but now happens on every zone and level transition.
   */
  private placeObjects: Phaser.GameObjects.GameObject[] = [];
  /**
   * The stamped terrain texture for the current Place, held so single tiles can be repainted.
   *
   * Terrain is static apart from doors, which is why it is one texture rather than ~10,000 game
   * objects — but a door that opens has to be redrawn, and redrawing means drawing six frames into
   * this rather than rebuilding the whole Place.
   */
  private mapTexture: Phaser.GameObjects.RenderTexture | undefined;

  constructor(net: Net, log: LogPanel) {
    super('world');
    this.net = net;
    this.log = log;
  }

  // Not `override`: Phaser calls these reflectively and does not declare them on the base class.
  preload(): void {
    for (const sheet of TILE_SHEETS) {
      this.load.spritesheet(sheet, `tiles/${sheet}.png`, {
        frameWidth: TILE_SIZE,
        frameHeight: TILE_SIZE,
      });
    }
    // The character layers, as spritesheets rather than images so a facing is a frame index rather than
    // five more textures. Frames run left-to-right then down, so row R column 0 is frame `R * columns` —
    // and every one of these sheets is one column wide except the bodies, which is why the frame is
    // computed from the sheet's own width in `layerFrame` rather than assumed.
    for (const sheet of LPC_SHEETS) {
      this.load.spritesheet(sheet, `lpc/${sheet}.png`, {
        frameWidth: LPC_FRAME,
        frameHeight: LPC_FRAME,
      });
    }
    // A missing tilesheet otherwise shows up as Phaser's magenta placeholder with no explanation.
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      this.log.write('error', `Failed to load artwork: ${file.key} (${file.src})`);
    });
  }

  create(): void {
    this.makeItemTextures();
    this.cameras.main.setBackgroundColor('#0b0d0a');
    this.cameras.main.setRoundPixels(true);

    const keyboard = this.input.keyboard;
    if (keyboard) {
      this.keys = keyboard.addKeys(
        'W,A,S,D,UP,LEFT,DOWN,RIGHT,M,Q,E,SHIFT',
      ) as Record<string, Phaser.Input.Keyboard.Key>;

      // Backquote toggles the log. Bound on the document so it works while the canvas has focus.
      keyboard.on('keydown-BACKTICK', () => this.log.toggle());
      // **One key, two views, and the modifier is read off the event.** `CLAUDE.md` gotcha 5b: polling
      // `Shift` in `update` after taking M's edge throws the chord away when the two land in different
      // frames, and the state at the moment of the press is what the player meant. Sharing `M` also
      // means no new key is registered for *capture* — gotcha 5a — so no additional letter can vanish
      // out of the command line.
      keyboard.on('keydown-M', (event: KeyboardEvent) => {
        if (this.typing) return;
        if (event.shiftKey) this.placeMap?.toggle();
        else this.toggleZoom();
      });
      // Escape closes it, which is what everybody tries. Handled before the log's own Escape, and
      // only when the overlay is actually up, so it cannot swallow the way out of the command line.
      keyboard.on('keydown-ESC', () => {
        if (this.placeMap?.isOpen) this.placeMap.hide();
      });

      // Doors. No direction is sent: the server holds the authoritative facing and resolves "the one
      // I am facing" itself, so walking up to a door and pressing O is the whole interaction. The
      // command line does the same thing with a direction — `open east` — for a door you are not
      // standing against.
      //
      // Not a modifier on the movement keys, which is the idiom Shift-travel established: Ctrl+W is
      // "close tab" in a browser, and the one place this game runs is a browser.
      keyboard.on('keydown-O', () => { if (!this.typing) this.net.send({ t: 'open' }); });
      keyboard.on('keydown-C', () => { if (!this.typing) this.net.send({ t: 'close' }); });

      // Enter opens the prompt, the MUD reflex. Bound here rather than on the window so it does not
      // fire while the caret is already in the input, where Enter means "send".
      keyboard.on('keydown-ENTER', () => { if (!this.typing) this.log.focusInput(); });

      // Taking an exit, on the press edge. See `takeExit` for why this is an event rather than a
      // `JustDown` poll in `update` — the poll dropped the step whenever the direction key landed a
      // frame ahead of Shift.
      for (const [key, dir, needsShift] of TRAVEL_KEYS) {
        keyboard.on(`keydown-${key}`, (event: KeyboardEvent) => this.takeExit(dir, needsShift, event));
      }
    }
    window.addEventListener('keydown', (event) => {
      // Backquote reaches the input as a typed character, so it must not also toggle the panel out
      // from under the caret.
      if (event.key === '`' && !this.log.inputFocused) this.log.toggle();
    });

    // Right-drag pans the camera, so the browser's own menu must not open on top of it — a context
    // menu appearing mid-gesture both hides the map and swallows the release that would end the pan.
    this.input.mouse?.disableContextMenu();

    // Here rather than in the constructor: a `Scene` is built before the page is necessarily ready,
    // and this reaches into the DOM for its element.
    this.targetMenu = new TargetMenu();

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => this.onPointerDown(pointer));
    // Releasing ends the *drag*, not the walk — see `endDrag`. Both events are bound because a
    // button released past the edge of the canvas only raises the second one, and a drag left
    // running because the release was never seen would re-path from a pointer nobody is holding.
    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => this.onPointerUp(pointer));
    this.input.on('pointerupoutside', (pointer: Phaser.Input.Pointer) => this.onPointerUp(pointer));
    // Phaser's wheel event carries the pointer as well as the delta, which is what makes zooming
    // about the cursor possible. The extra arguments are the objects under the pointer and the
    // other two axes; none of them matter here.
    this.input.on(
      'wheel',
      (pointer: Phaser.Input.Pointer, _over: unknown, _deltaX: number, deltaY: number) =>
        this.onWheel(pointer, deltaY),
    );

    this.createPathLayer();
    this.wireBrightness();
    this.wireHint();
    this.wireSheet();
    this.wireInventory();
    this.wireNetwork();
  }

  /**
   * Tells the renderer its viewport changed size.
   *
   * `Scale.RESIZE` sizes the canvas to `#game`'s box, but the scale manager only listens for **window**
   * resizes — and collapsing a pane resizes a grid *column*, which raises no such event. Without this
   * the canvas keeps its old width and the map is drawn into a letterbox of the space it now has.
   *
   * The camera needs no attention: it follows the character, so a wider viewport re-centres on its own
   * next frame. Nothing here touches zoom either — the ladder is a player choice and must survive
   * showing a panel.
   */
  refreshViewport(): void {
    // A scene has no scale manager until a `Game` adds it, and a pane can be shown or hidden from the
    // DOM before that happens — restoring a remembered collapse is exactly that case. Guarding here
    // rather than at each caller, because "the renderer is not up yet" makes this a no-op by nature:
    // whatever size the column ends up, the first boot measures it.
    if (!this.scale || !this.sys.isActive()) return;
    // **Both calls, in this order.** `refresh()` resizes the canvas from the scale manager's *cached*
    // parent size, and that cache is only refilled by its own step — so calling it alone applies the
    // width the column had *before* the class changed, and the canvas ends up one collapse behind the
    // layout. Measured: collapsing the log took the stage to 707px and left the canvas at 480.
    // `getParentBounds()` is what re-reads the DOM, so it has to run first.
    this.scale.getParentBounds();
    this.scale.refresh();
    // A `fit` zoom is a function of the viewport, so the one zoom level that *is* derived has to be
    // recomputed. Every other rung is a fixed ratio and is left exactly where the player put it.
    if (this.fitMode) this.frameCamera();
  }

  /**
   * Shows or hides the character sheet, and remembers the choice.
   *
   * The same two-class dance the log does — see `LogPanel.setCollapsed` — because the pane's own
   * layout and the grid column it occupies are different facts and CSS cannot derive one from the
   * other. Shown by default: it is where your hit points are.
   */
  private wireSheet(): void {
    const pane = document.getElementById('sheet');
    const bar = document.getElementById('sheet-bar');
    const caret = document.getElementById('sheet-caret');
    const shell = document.getElementById('shell');
    if (!pane || !bar) return;

    let collapsed = false;
    try {
      collapsed = localStorage.getItem(SHEET_STORAGE_KEY) === '1';
    } catch {
      // Storage disabled. Showing the sheet is the safer default of the two.
    }

    const apply = (next: boolean, persist: boolean) => {
      collapsed = next;
      pane.classList.toggle('hidden', collapsed);
      shell?.classList.toggle('sheet-hidden', collapsed);
      if (caret) caret.textContent = collapsed ? '◂' : '▸';
      if (persist) {
        try {
          localStorage.setItem(SHEET_STORAGE_KEY, collapsed ? '1' : '0');
        } catch {
          // A preference that does not survive a reload beats a crash.
        }
      }
      this.refreshViewport();
    };

    bar.addEventListener('click', () => apply(!collapsed, true));
    apply(collapsed, false);
  }

  /**
   * The inventory drawer.
   *
   * Purely local: there is no `inventory` command and no items on the wire, so this opens and closes a
   * panel and nothing else. It is wired now because the sheet it lives in is being built now, and the
   * empty state it shows is **true** rather than a placeholder — a character with no item system is
   * carrying nothing, and that is exactly what a MUD would tell you. When items land in Phase 15 this
   * grows a renderer for them; it does not grow a reason to exist.
   */
  private wireInventory(): void {
    const button = document.getElementById('inventory-toggle');
    const panel = document.getElementById('inventory');
    const caret = document.getElementById('inventory-caret');
    if (!button || !panel) return;

    this.renderInventory(this.lastBag);
    button.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (caret) caret.textContent = open ? '▾' : '▸';
    });

    // The worn drawer, the same gesture — owner's call (2026-08-07) after the doll grid pushed the
    // combat feed below the fold: gear is reference between fights, so it folds and the fight rises.
    const wornButton = document.getElementById('worn-toggle');
    const wornBody = document.getElementById('worn-body');
    const wornCaret = document.getElementById('worn-caret');
    if (wornButton && wornBody) {
      wornButton.addEventListener('click', () => {
        const open = wornBody.classList.toggle('open');
        wornButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (wornCaret) wornCaret.textContent = open ? '▾' : '▸';
      });
    }
  }

  /**
   * Draws what the character is carrying — protocol 15.
   *
   * **This replaced a stub that always said "you are carrying nothing".** 15a wired the drawer before
   * there was anything on the wire to put in it, and said so in a comment; by 2026-08-04 the bag was
   * real, the line was simply false, and the owner reported it as a bug. It was one.
   *
   * The shape matches the `inventory` command's own listing on purpose — counts, charges, a container's
   * fullness and its contents indented — because they answer the same question and two renderings of
   * one bag that could disagree is a bug nobody thinks to look for.
   *
   * Names are **painted**, never assigned: they are the builder's authored text and carry the MUD's own
   * colour codes. The paper doll learned this the hard way when 15c's harvested items first arrived.
   */
  /** The last bag the server sent, so opening the drawer redraws rather than waiting for a heartbeat. */
  private lastBag: BagView | undefined;

  /** Indexed sheets wanted but not yet asked for — drained by `pumpSheetQueue` from `update`. */
  private readonly wantedSheets = new Set<string>();
  /** Indexed sheets currently in flight, so a room of six wearing one hat asks the loader once. */
  private readonly loadingSheets = new Set<string>();

  /** The arrow over the body you are fighting or chasing, and whose it is. */
  private marker: Phaser.GameObjects.Graphics | undefined;
  private markerId: EntityId | undefined;

  /**
   * Points the marker at a body, or takes it off the screen.
   *
   * **Drawn on an entity the client actually holds**, which is what makes it immune to the one thing
   * the server cannot promise: `SelfView.target` may name a body that has fled somewhere unlit, and an
   * id with no entity behind it simply has nothing to mark. No rule needed — it falls out.
   */
  private setTarget(id: EntityId | undefined): void {
    this.markerId = id;
    if (!this.marker) {
      // A downward chevron rather than a ring: it sits *above* the body without covering it, and it
      // reads at this sprite scale where a reticle turns into a smudge.
      //
      // **Built before the body is looked up**, not after. It used to be created inside the branch
      // that had an entity in hand, so the first target a player ever pointed at from outside the
      // room — the quarry they are chasing — created nothing, and `update` had no object to show when
      // that body finally walked into view. A chevron that only exists once it has been seen cannot
      // be the thing that tells you where your quarry went.
      const g = this.add.graphics();
      g.fillStyle(0xe0c46a, 1);
      g.fillTriangle(-5, -5, 5, -5, 0, 3);
      g.lineStyle(1, 0x2a2620, 1);
      g.strokeTriangle(-5, -5, 5, -5, 0, 3);
      g.setDepth(DEPTH_MARKER);
      this.marker = g;
    }
    const entity = id === undefined ? undefined : this.entities.get(id);
    if (!entity) {
      this.marker.setVisible(false);
      return;
    }
    this.marker.setVisible(true);
    this.marker.setPosition(Math.round(entity.x), Math.round(entity.y) - MARKER_HEIGHT);
  }

  /**
   * The speech bubbles currently up, one per speaker — V3.
   *
   * **Keyed by entity rather than a list**, because somebody who says two things in a row has one
   * mouth: the second replaces the first rather than stacking a tower of bubbles over their head.
   * A whole room can be talking at once and each body carries its own.
   */
  private readonly bubbles = new Map<EntityId, { node: Phaser.GameObjects.Container; until: number }>();

  /**
   * Puts a bubble over the body that just spoke — V3, and the whole of it.
   *
   * **Drawn only on an entity the client already holds**, which is what makes the visibility gate
   * unbreakable here rather than merely respected. The server sends `from` to everyone who may hear
   * the line, including people standing outside the speaker's torchlight — and their client has no
   * entity for that id, so there is nothing to attach a bubble to and nothing is drawn. They still
   * get the log line, which reads *"someone says"*. The gate is applied once, on the server, and the
   * renderer is structurally unable to disobey it. Same fall-out the target chevron relies on.
   *
   * Positioned per frame in `update` beside the body rather than parented to its container, for the
   * reason the chevron is: a sprite that flips when it walks west would mirror the text.
   */
  private sayInWorld(id: EntityId, text: string): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    this.bubbles.get(id)?.node.destroy();

    const label = this.add
      .text(0, 0, text, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#f2ead8',
        align: 'center',
        wordWrap: { width: SPEECH_WRAP_PX },
      })
      .setOrigin(0.5, 1);

    // A plate behind the words, sized from the text **after wrapping** rather than from its length:
    // the wrap decides the real box, and guessing it from a character count is wrong on the first
    // sentence that breaks early.
    //
    // The container's origin is the point just above the speaker's head, and everything is built
    // upward from it: the tail's tip sits at 0, the plate's bottom edge at −TAIL, its top edge a box
    // higher again. Laying it out from the tip means the thing that has to touch the body is the one
    // coordinate that is not the sum of three others.
    const PAD = 4;
    const TAIL = 6;
    const w = label.width + PAD * 2;
    const h = label.height + PAD * 2;
    const plate = this.add.graphics();
    plate.fillStyle(0x1b1a16, 0.86);
    plate.lineStyle(1, 0x6d6552, 1);
    plate.fillRoundedRect(-w / 2, -TAIL - h, w, h, 4);
    plate.strokeRoundedRect(-w / 2, -TAIL - h, w, h, 4);
    // The tail, so a bubble in a crowd points at whose it is. A triangle rather than a rounded nub:
    // at this size anything softer reads as a smudge.
    plate.fillTriangle(-4, -TAIL, 4, -TAIL, 0, 0);

    // Origin (0.5, 1) — the label hangs from its own bottom edge, which is the plate's inner floor.
    label.setPosition(0, -TAIL - PAD);
    const node = this.add.container(0, 0, [plate, label]).setDepth(DEPTH_SPEECH);
    const dwell = Math.min(SPEECH_MAX_MS, SPEECH_MIN_MS + text.length * SPEECH_MS_PER_CHAR);
    this.bubbles.set(id, { node, until: this.time.now + dwell });
  }

  /**
   * Moves every bubble onto its speaker and retires the ones whose time is up.
   *
   * Run from `update` for the same reason the chevron's positioning is: bodies are eased toward the
   * server's position every frame, and a bubble placed once would drift off the head of anybody who
   * so much as steps sideways while talking.
   *
   * A speaker who leaves the room takes their bubble with them — the entity is gone from the map, so
   * the lookup misses and the bubble is dropped rather than left floating over empty floor.
   */
  private advanceBubbles(): void {
    for (const [id, bubble] of this.bubbles) {
      const entity = this.entities.get(id);
      if (!entity || this.time.now >= bubble.until) {
        bubble.node.destroy();
        this.bubbles.delete(id);
        continue;
      }
      bubble.node.setPosition(Math.round(entity.x), Math.round(entity.y) - SPEECH_HEIGHT);
      // **Counter-scaled against the camera, so the bubble is a constant size on screen.** It lives
      // in world space — it has to, or it could not follow a body that walks — and world space is
      // scaled by the zoom ladder, which runs from 0.25 to 2. Left alone, the first drive had one
      // sentence covering a quarter of the map at close zoom, and the same sentence would be three
      // unreadable pixels at `fit`. Dividing by the zoom cancels the camera exactly: the local size
      // times 1/zoom times zoom is the size it was authored at, whatever the player has chosen.
      //
      // The *offset* above the head deliberately stays in world units, because the body it points at
      // scales too — a screen-constant offset would drift off the head at every zoom but one.
      bubble.node.setScale(1 / this.cameras.main.zoom);
    }
  }

  private renderInventory(bag?: BagView): void {
    const panel = document.getElementById('inventory');
    if (!panel) return;
    panel.replaceChildren();

    if (!bag || bag.rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'You are carrying nothing.';
      panel.append(empty);
      // The purse still shows: coin is not in the bag — `DESIGN-inventory.md` §8 — and a character with
      // no kit and eight gold should see the eight gold.
      if (bag?.purse) panel.append(this.purseLine(bag.purse));
      return;
    }

    const slots = document.createElement('div');
    slots.className = 'bag-slots';
    slots.textContent = `${bag.used} of ${bag.capacity} slots`;
    panel.append(slots);

    const rowNode = (row: BagRow, depth: number): HTMLElement => {
      const node = document.createElement('div');
      node.className = depth > 0 ? 'bag-row nested' : 'bag-row';

      // **A7d-bag: the picture, when the item has one.** The cell is always present and always the same
      // size, even for the rows with no art — otherwise a bag holding one cloak and five keys would have
      // one indented name and five flush ones, and the list would look broken rather than sparse.
      const icon = document.createElement('span');
      icon.className = 'bag-icon';
      node.append(icon);
      if (row.art !== undefined) {
        // Asynchronous because the sheet has to be fetched and read back. The row is complete without
        // it, so nothing waits: the picture arrives into a cell that is already laid out, and a failure
        // leaves the cell empty rather than the row unrendered. Cached in `bagicon.ts`, so a redraw on
        // the next heartbeat costs nothing and does not flicker.
        void bagIcon(row.art).then((url) => {
          if (!url) return;
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          icon.replaceChildren(img);
        });
      }

      const name = document.createElement('span');
      name.className = 'item';
      paint(name, row.name);
      node.append(name);

      // The count, the charges and the fullness are each shown only when they say something. A sword
      // reading "(x1)" or "[0/0]" is noise that makes the real numbers harder to see.
      const notes: string[] = [];
      if (row.count !== undefined && row.count > 1) notes.push(`x${row.count}`);
      if (row.remaining !== undefined) notes.push(`${row.remaining} left`);
      if (row.holds) notes.push(`${row.holds[0]}/${row.holds[1]}`);
      if (depth === 0) notes.push(`${row.slots} slot${row.slots === 1 ? '' : 's'}`);
      if (notes.length > 0) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = notes.join(' · ');
        node.append(tag);
      }
      return node;
    };

    for (const row of bag.rows) {
      panel.append(rowNode(row, 0));
      // A container's contents, indented under it — the same choice the text listing makes, and for the
      // same reason: the arrows in your quiver are still yours, and hiding them behind a second command
      // would make a quiver feel like storage rather than like carrying.
      for (const inside of row.contents ?? []) panel.append(rowNode(inside, 1));
    }
    if (bag.purse) panel.append(this.purseLine(bag.purse));
  }

  /**
   * Coin, richest metal first and **each in its own colour**.
   *
   * Built through `describePurse` rather than formatted here, so the drawer and the game's own log
   * cannot come to write a purse two different ways — the same argument the bag's row shape makes
   * against the `inventory` command. The colours are the MUD's `&+` codes, so they go through
   * `parseColour` exactly as a builder's item name does and the palette stays in one place.
   */
  private purseLine(purse: Readonly<Record<string, number>>): HTMLElement {
    const node = document.createElement('div');
    node.className = 'bag-purse';
    paint(node, describePurse(purse));
    return node;
  }

  /**
   * Fills the equipment paper doll.
   *
   * Two sources, and the order between them is the interesting part.
   *
   * **Worn kit** arrives from Phase 14b: a rolled starting outfit, each piece with its own armour
   * value, which is why two level-1 characters are not the same character.
   *
   * **A light no longer takes the main hand, and deleting that was overdue** — owner, 2026-08-06:
   * *"move the ring of testing out my main hand; make it a light source like any other, it doesn't need
   * to be held or worn."*
   *
   * 15a wrote the override and its own comment predicted this removal (*"Phase 15 collapses the two into
   * one list and this special case goes"*). Phase 16 is what made it wrong rather than merely interim:
   * light is now derived from what is actually in a light-bearing slot, so a torch you are holding **is**
   * `equipped.mainHand` and the doll draws it from the kit unaided. What the override did after that was
   * lie — a light that is *not* an equipped item (the dev ring, or a scattered pickup, both of which
   * `syncHeldLight` deliberately leaves alone) painted itself into a hand holding a sword, and hid the
   * sword.
   *
   * The useful half is kept: whichever slot holds the item the light *came from* is marked lit, matched
   * on the id the wire already carries. So a torch still glows in the hand it occupies, and a light that
   * occupies nothing glows nowhere — which is what it is. It has had its own HUD line since Phase 1.
   */
  private applyEquipment(light: CarriedLight | undefined, equipped: Equipped | undefined): void {
    const worn: Partial<Record<string, { readonly name: string; readonly lit?: boolean; readonly ac?: number }>> = {};
    for (const [slot, item] of Object.entries(equipped ?? {})) {
      // `lit` by identity rather than by slot: the id is what the server matched to derive the radius,
      // so this cannot disagree with the light it is describing.
      if (item) worn[slot] = { name: item.name, ac: item.ac, ...(light && item.id === light.id ? { lit: true } : {}) };
    }

    for (const id of EQUIPMENT_SLOTS) {
      const cell = document.getElementById(`slot-${id}`);
      if (!cell) continue;
      const item = worn[id];
      const label = cell.querySelector('.item');
      // The armour value is shown because it is the whole reason the kit is rolled: without it two
      // characters in identical-looking leather have no way to know which of them got lucky.
      //
      // **Painted, not assigned.** Found live the moment 15c's harvested items arrived: an item's name
      // is *authored text* and carries the MUD's own colour codes — `&+ma steel long sword` — so
      // `textContent` printed the codes verbatim in every slot. The starter kit's names have none,
      // which is exactly why this survived 15a and 15b. Same rule V6 set for the log: anything a
      // builder wrote goes through `parseColour`.
      if (label instanceof HTMLElement) {
        paint(label, item ? (item.ac ? `${item.name} (+${item.ac})` : item.name) : 'empty');
      }
      cell.classList.toggle('empty', item === undefined);
      cell.classList.toggle('lit', item?.lit === true);
    }

    // **The slots the doll has no cell for, listed only when something is in them.** Phase 16 took the
    // slot set to Duris' twenty-four, and a body diagram with twenty-four boxes around it stops reading
    // as a body. These are the rare finds — an eyepatch, a cloak, a pair of bracers — and the owner's
    // reason for wanting them at all is that they *should be usable when found*, which means visible
    // when worn and invisible when not.
    const extra = document.getElementById('worn-extra');
    if (extra instanceof HTMLElement) {
      const dollCells = new Set<string>(DOLL_SLOTS);
      const rows = EQUIPMENT_SLOTS.filter((slot) => !dollCells.has(slot) && worn[slot] !== undefined);
      extra.replaceChildren();
      extra.classList.toggle('empty', rows.length === 0);
      for (const slot of rows) {
        const item = worn[slot]!;
        const row = document.createElement('div');
        row.className = 'worn-row';
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = SLOT_LABEL[slot] ?? slot;
        const name = document.createElement('span');
        name.className = 'item';
        // Painted for the same reason the doll's cells are: these names are the builder's own text.
        paint(name, item.ac ? `${item.name} (+${item.ac})` : item.name);
        row.append(tag, name);
        extra.append(row);
      }
    }
  }

  /**
   * The map-brightness slider.
   *
   * Purely a display preference — it changes how dark remembered ground is drawn and nothing else.
   * It cannot reveal anything: unknown tiles stay at {@link FOG_UNKNOWN} regardless of where the
   * slider sits, and what may be walked to is gated server-side on the `seen` bitset, not on
   * anything this touches. So it needs no authority and lives entirely in the browser.
   */
  /**
   * Folds the key reference away, and remembers that you did.
   *
   * A reference card has a lifecycle a HUD does not: indispensable for the first ten minutes, clutter
   * for every hour after that. Remembering the choice is most of the value — a panel you have to
   * dismiss on every reload is worse than one that never moves.
   *
   * Only the title bar takes pointer events. The rows stay click-through, because the panel sits over
   * the map and swallowing clicks across that whole corner would be a worse trade than the clutter.
   */
  private wireHint(): void {
    const panel = document.getElementById('hint');
    const bar = document.getElementById('hint-bar');
    const caret = document.getElementById('hint-caret');
    if (!panel || !bar) return;

    // Collapsed unless the player has explicitly opened it before. The card is a reference, not a
    // HUD: it earns its space for the first ten minutes and costs a third of the map's width for every
    // hour after. `!== '0'` rather than `=== '1'` so "never chosen" lands on hidden.
    let collapsed = true;
    try {
      collapsed = localStorage.getItem(HINT_STORAGE_KEY) !== '0';
    } catch {
      // Storage disabled. Hidden is still the right default; the bar is one click.
    }

    const apply = (next: boolean, persist: boolean) => {
      collapsed = next;
      panel.classList.toggle('collapsed', collapsed);
      if (caret) caret.textContent = collapsed ? '▸' : '▾';
      if (!persist) return;
      try {
        localStorage.setItem(HINT_STORAGE_KEY, collapsed ? '1' : '0');
      } catch {
        // A preference that does not survive a reload beats a crash.
      }
    };

    bar.addEventListener('click', () => apply(!collapsed, true));
    apply(collapsed, false);
  }

  private wireBrightness(): void {
    const slider = document.getElementById('brightness');
    const readout = document.getElementById('brightness-value');
    if (!(slider instanceof HTMLInputElement)) return;

    let initial = REMEMBERED_BRIGHTNESS_DEFAULT;
    try {
      const stored = Number(localStorage.getItem(BRIGHTNESS_STORAGE_KEY));
      if (Number.isFinite(stored) && stored > 0) initial = stored;
    } catch {
      // Private browsing, or storage disabled. The default is fine; a preference is not worth
      // failing to start over.
    }

    const apply = (percent: number, persist: boolean) => {
      this.rememberedAlpha = brightnessToAlpha(percent);
      if (readout) readout.textContent = `${Math.round(percent)}%`;
      // Repaint immediately rather than marking dirty: the fog is only repainted when visibility
      // changes, so a stationary character would otherwise see nothing happen as they drag.
      this.paintFog();
      if (!persist) return;
      try {
        localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(Math.round(percent)));
      } catch {
        // As above — a setting that does not survive a reload beats a crash.
      }
    };

    slider.value = String(Math.round(initial));
    slider.addEventListener('input', () => apply(Number(slider.value), true));
    apply(initial, false);
  }

  private wireNetwork(): void {
    this.net.on('welcome', (message) => {
      this.selfId = message.you;

      // A fresh connection is the *only* thing that resets what has been seen. `zone` arrives
      // mid-session on every arrival at a new Place, and clearing the fog there would wipe the map
      // each time the player crossed a zone border. The server re-sends the authoritative `seen`
      // bitset for wherever the character is standing immediately after this message.
      this.seen = undefined;
      this.seenSnapshot = undefined;
      this.clearVisible();
      this.lightRadius = DEFAULT_LIGHT_RADIUS;
      // Whatever was being carried belonged to the character on the old socket. The server states
      // it again in the `self` that follows; until then, the bare eye.
      this.carriedLight = undefined;
      this.lightDeadline = undefined;
      this.lightHudKey = undefined;
      // Same reasoning: whatever was affecting the character belonged to the old socket's copy of them.
      this.affects = [];
      this.affectsHudKey = undefined;
      this.selfRoomId = undefined;
      this.zone = undefined;
      this.place = undefined;
      this.pendingArrival = false;
      // A reconnect spawns a fresh server-side player whose intent is zero, whatever this client
      // last sent down the old socket.
      this.resendIntent = true;

      // Nothing from the previous session survives a reconnect — not even the local player, whose
      // entity id the server is free to reissue. Drop the follow before its target is destroyed.
      this.stopFollowing();
      this.clearEntities(false);
      this.drawPath([]);
      this.serverWalking = false;
      this.lastClick = undefined;
      this.manualControl = false;
      this.endDrag();
    });

    this.net.on('zone', (message) => this.buildZone(message.zone, message.level));

    this.net.on('door', (message) => this.applyDoor(message.room, message.dir, message.closed));

    this.net.on('seen', (message) => {
      this.seenSnapshot = { place: message.place, bits: message.bits };
      this.applySeenSnapshot();
    });

    this.net.on('seenDelta', (message) => {
      const seen = this.seen;
      // Before the first `seen` there is nothing to extend. Dropping the delta is safe: the snapshot
      // that follows is the union of everything, including these tiles.
      if (!seen) return;
      let changed = false;
      for (const index of message.tiles) changed = bitsetAdd(seen, index) || changed;
      // Only newly-seen ground changes the picture, and the server may batch a tick that added
      // nothing. Repainting on every tick regardless would undo the point of repainting on change.
      if (changed) this.invalidateFog();
    });

    this.net.on('room', (message) => {
      setText('hud-where', message.view.room.name);
      // The room a `room` message describes is the one the character is standing in, and it arrives
      // on every transition — earlier than `self`, which only follows when a number changed. A
      // beacon's lit set is keyed off this id, so taking it from whichever message states it first
      // keeps the light in step with the doorway rather than a tick behind it.
      this.setSelfRoom(message.view.room.id);
      for (const view of message.view.entities) this.upsertEntity(view);
      // Anything the server no longer lists for this room is gone.
      const present = new Set(message.view.entities.map((e) => e.id));
      for (const [id] of this.entities) {
        if (!present.has(id) && id !== this.selfId) this.removeEntity(id);
      }
    });

    this.net.on('self', (message) => {
      setText('hud-name', `${message.view.name}  lvl ${message.view.level}`);
      this.setSelfRoom(message.view.roomId);
      this.applyLight(message.view.lightRadius, message.view.light);
      this.applyEquipment(message.view.light, message.view.equipped);
      // **Kept, because the drawer can be opened after the message that filled it.** `self` arrives on
      // every vitals change; the panel is only in the DOM to be redrawn when it is open, so the last
      // bag is held and re-rendered when it opens. Without this, opening the drawer between heartbeats
      // shows an empty bag until something hits you.
      this.lastBag = message.view.bag;
      this.setTarget(message.view.target);
      this.renderInventory(this.lastBag);
      this.applyAffects(message.view.affects);
      this.applyStance(message.view.posture, message.view.status);
      this.applyPools(message.view);
    });
    this.net.on('entityEnter', (message) => this.upsertEntity(message.entity));
    this.net.on('entityLeave', (message) => this.removeEntity(message.id));
    this.net.on('entityUpdate', (message) => this.upsertEntity(message.entity));

    this.net.on('entityMoved', (message) => {
      for (const move of message.moves) {
        const entity = this.entities.get(move.id);
        if (!entity) continue;
        entity.serverX = move.x;
        entity.serverY = move.y;
        entity.view = { ...entity.view, facing: move.facing };
        // Everyone else turns here; *you* turn in the update loop, off the same stored value — it
        // reconciles your predicted position in the same place, and both halves of "where am I and
        // which way am I looking" should be settled together rather than a frame apart.
        if (move.id !== this.selfId) this.faceEntity(entity, move.facing);
      }
    });

    // Protocol 22: the structured half announceAttack has sent since Phase 11 finally has its
    // reader — the swing plays on the attacker's body. The prose stays the combat feed's; this is
    // the motion. An attacker the client holds no entity for (unseen, or the message raced the
    // room view) animates nothing, which is the same sight gate every other per-entity visual keeps.
    this.net.on('attackResolved', (message) => {
      if (message.swing) this.playSwing(message.attacker, message.swing);
    });

    this.net.on('path', (message) => {
      // An empty array is the protocol's "no path", whether the route arrived, was abandoned, or was
      // dropped by a step through an exit.
      this.serverWalking = message.points.length > 0;
      this.drawPath(message.points);
    });
    // The reason is deliberately unused: the server sends the sentence, this only flashes the spot.
    this.net.on('pathFailed', () => this.reportPathFailure());

    // Combat lines are deliberately absent: they belong to the combat feed in the character pane
    // (`combatfeed.ts`, wired in `main.ts`), and the owner's rule is a split rather than a mirror —
    // prose and speech on the left, violence on the right. Everything else lands here unchanged.
    this.net.on('log', (message) => {
      if (message.channel !== 'combat') this.log.write(message.channel, message.text);
      // V3. The same message, read a second way: the log gets the sentence with the speaker's name in
      // it, the world gets the words over the speaker's head. Both or neither — they arrive together
      // because they *are* together, which is what stops the two from ever disagreeing about who
      // heard what.
      if (message.from !== undefined && message.speech !== undefined) {
        this.sayInWorld(message.from, message.speech);
      }
    });
    this.net.on('rejected', (message) => this.log.write('error', `Rejected: ${message.reason}`));
  }

  /* ------------------------------------------------------------ click to move */

  /**
   * Turns a click into a `moveTo` *intent* — a destination, never a route.
   *
   * The server owns the pathfinding because the route has to be gated on the tiles this character
   * has *seen*, and a client that computed its own path could simply ignore that and walk through
   * the dark. This client holds a copy of that bitset to paint with, never to decide with.
   */
  /**
   * The body nearest a world point, within {@link CLICK_REACH}, or nothing.
   *
   * Yourself is excluded: you are always under the pointer at the centre of the screen, and a menu
   * offering to attack yourself is a menu that is in the way. Nearest wins, so two bodies standing
   * a tile apart both stay clickable — which is exactly the case the menu exists for.
   */
  private entityAt(worldX: number, worldY: number): { entity: Entity; distance: number } | undefined {
    let best: Entity | undefined;
    let bestDistance = CLICK_REACH;
    for (const [id, entity] of this.entities) {
      if (id === this.selfId) continue;
      const distance = Math.hypot(entity.x - worldX, entity.y - worldY);
      if (distance > bestDistance) continue;
      best = entity;
      bestDistance = distance;
    }
    // The distance rides along because the press handler referees between this and a portal hit —
    // and a referee that only hears one side's number was this exact bug (owner, 2026-08-07).
    return best ? { entity: best, distance: bestDistance } : undefined;
  }

  /**
   * Offers what can be done to one body.
   *
   * Every verb sends an intent naming the entity's **id**, which is the whole point: a keyword cannot
   * say which of three identically-named guards you meant, and since they move, neither can position.
   * The server resolves the id through the same visible-set gate a typed word passes, so this is a
   * more precise way to ask and not a more powerful one.
   *
   * The rows are what exists today. Three cases, all keyed off the **sprite** rather than a type on
   * the wire, because `kind: 'item'` covers both a body and a dropped object and the server keeps them
   * in two different stores:
   *
   * - a corpse (`corpse`, `corpse_looted`) offers `Loot`, which searches it;
   * - anything else drawn as an item offers `Get`, which picks it up;
   * - anything with a body offers `Attack`.
   *
   * The split matters because the two verbs send different messages — `loot` resolves against the
   * graveyard and `get` against the ground store — and an id belongs to exactly one of them. Later
   * mechanics add rows here: `bash` with Phase 19's skills is already recorded against that phase.
   */
  private openTargetMenu(pointer: Phaser.Input.Pointer, entity: Entity): void {
    const view = entity.view;
    const verbs: TargetVerb[] = [
      { label: 'Look at', run: () => this.net.send({ t: 'look', target: view.id }) },
    ];
    const corpse = view.kind === 'item' && view.sprite.startsWith('corpse');
    if (corpse) {
      verbs.push({ label: 'Loot', run: () => this.net.send({ t: 'loot', target: view.id }) });
    } else if (view.kind === 'item') {
      // **Above `Get`, because reading a sack is what you do before deciding to carry it.** The row
      // exists only for things the server flagged as containers — 419 of the catalogue's 16,421 — so a
      // dropped dagger's menu is unchanged. Owner's point about the floor generally: *"not everyone
      // reads every description"*, and a verb reachable only by typing `look in` is one most players
      // never find.
      if (view.container) {
        verbs.push({ label: 'Look inside', run: () => this.net.send({ t: 'look', target: view.id, inside: true }) });
      }
      verbs.push({ label: 'Get', run: () => this.net.send({ t: 'get', target: view.id }) });
    } else {
      verbs.push({
        label: 'Attack',
        danger: true,
        run: () => this.net.send({ t: 'attack', target: view.id }),
      });
    }
    this.targetMenu.show(pointer.x, pointer.y, stripColour(view.name), verbs);
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (!this.grid) return;

    // Secondary buttons pan the camera and do nothing else — no click, no steering, no path.
    if (pointer.rightButtonDown() || pointer.middleButtonDown()) {
      this.beginPan(pointer);
      return;
    }
    if (!pointer.leftButtonDown()) return;
    if (this.overUiPanel(pointer)) return;

    // Clicking the world is the player taking the wheel back, so the camera goes back to the
    // character. Panning is a look-around gesture; walking somewhere means you want to watch it.
    this.followSelf();

    // Clicking the world means you want to play, not type. Done explicitly rather than relying on
    // the browser to move focus, because Phaser calls `preventDefault` on the canvas and a click
    // that left the caret in the prompt would silently swallow the next WASD.
    if (this.log.inputFocused) this.log.blurInput();

    // World, not screen: the camera scrolls with the character and the wheel zooms it, so the same
    // pixel means a different tile from one frame to the next.
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);

    // **Did they click a body?** V2. A press on something in the room is a request to act on *that*
    // one, so it opens the menu instead of walking — and it must not also start a drag, or letting go
    // would fling the character at whatever was underneath.
    //
    // Any open menu closes first, whatever was clicked: a stale menu still naming the guard you were
    // looking at two rooms ago is worse than no menu.
    this.targetMenu.close();
    // **A body or a portal — both are asked, and the nearer one wins.** Checked here rather than
    // through per-object `pointerdown` handlers, and the difference is not stylistic: this method
    // runs for every press and ends by walking you somewhere, so an object handling its own press
    // still gets walked over a frame later. One hit test, one decision.
    //
    // Bodies win a **tie**, and only a tie: a mob standing on the portal is what you meant to click.
    // The first version asked bodies first and portals only when no body answered, and the owner
    // found what that costs (2026-08-07): a kobold a full tile away won against the portal under the
    // pointer, because the body's generous CLICK_REACH was consulted before the portal ever was.
    const clicked = this.entityAt(world.x, world.y);
    const portal = this.portalAt(world.x, world.y);
    if (clicked && (!portal || clicked.distance <= portal.distance)) {
      this.openTargetMenu(pointer, clicked.entity);
      return;
    }
    if (portal) {
      this.targetMenu.show(pointer.x, pointer.y, `a portal leading ${portal.dir}`, [
        { label: 'Enter portal', run: () => this.net.send({ t: 'move', dir: portal.dir }) },
      ]);
      return;
    }

    // The press is a plain click first and the start of a possible drag second. Order matters: a
    // click that turns out to be a drag must behave, at this instant, exactly as it always has.
    this.beginDrag(pointer);
    this.requestMoveTo(world.x, world.y, false);
  }

  /**
   * A release ends the drag, and the character stops.
   *
   * A joystick that kept going after being let go would be a joystick you cannot stop without
   * pressing a key. The heading is cleared here; {@link update} notices the intent changed on the
   * next frame and sends the `steer 0,0` that halts the character — the same message a key release
   * sends, through the same path.
   */
  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    if (this.dragPointer === pointer) this.endDrag();
    if (this.panPointer === pointer) this.endPan();
  }

  /* ------------------------------------------------------------- camera panning */

  /**
   * Starts a camera pan, and lets go of the character.
   *
   * `stopFollowing` is the whole point of the gesture: Phaser's follow hard-sets the scroll every
   * frame, so a pan that left it attached would be overwritten before it was ever drawn. Letting go is
   * therefore not a side effect to be tidied up later — it is what panning *is*.
   *
   * Nothing re-attaches on release. A player who panned across the map to look at something wants it
   * to stay where they put it; the camera comes back when they next drive — a click, a movement key, a
   * zoom rung or `M`.
   */
  private beginPan(pointer: Phaser.Input.Pointer): void {
    this.panPointer = pointer;
    this.panLastX = pointer.x;
    this.panLastY = pointer.y;
    this.stopFollowing();
    // A pan is not a joystick. Cancelling any live left-drag stops the character carrying on walking
    // in whatever direction the pointer was last pointing while the view slides out from under it.
    this.endDrag();
  }

  private endPan(): void {
    this.panPointer = undefined;
  }

  /**
   * Scrolls the camera by however far the pointer moved. Called once a frame.
   *
   * Divided by the zoom, because `scroll` is in **world** units and the pointer moved in screen ones:
   * at 0.5 zoom a 10px drag has to move the camera 20 world pixels or the map would visibly lag behind
   * the hand at every rung but 1. Phaser clamps the result to the camera bounds, which is what stops a
   * pan wandering off into the void — see {@link applyCameraBounds}.
   */
  private updatePan(): void {
    const pointer = this.panPointer;
    if (!pointer) return;

    // A release outside the window raises no event this scene sees, so Phaser's own record of the
    // buttons is the backstop — the same guard `updateDrag` keeps, for the same reason.
    if (!pointer.isDown || !(pointer.rightButtonDown() || pointer.middleButtonDown())) {
      this.endPan();
      return;
    }

    const camera = this.cameras.main;
    const dx = pointer.x - this.panLastX;
    const dy = pointer.y - this.panLastY;
    this.panLastX = pointer.x;
    this.panLastY = pointer.y;
    if (dx === 0 && dy === 0) return;

    // Dragging right pulls the map right, which means the camera moves *left*. Inverting it would be
    // "move the camera with the mouse" rather than "drag the map", and the map is the thing under the
    // cursor.
    camera.setScroll(camera.scrollX - dx / camera.zoom, camera.scrollY - dy / camera.zoom);
  }

  private beginDrag(pointer: Phaser.Input.Pointer): void {
    this.dragPointer = pointer;
    this.dragPressedAt = this.time.now;
    this.dragSteering = false;
  }

  private endDrag(): void {
    this.dragPointer = undefined;
    this.dragSteering = false;
    this.dragIntentX = 0;
    this.dragIntentY = 0;
  }

  /**
   * Points the joystick at the held pointer. Called once a frame.
   *
   * Sends nothing itself: it only sets a heading, which {@link update} folds into the one intent it
   * already computes and transmits. A pointer that has not moved therefore costs nothing on the wire,
   * because the intent it produces is identical from frame to frame.
   */
  private updateDrag(now: number): void {
    const pointer = this.dragPointer;
    if (!pointer) return;

    // A release outside the browser window raises no event this scene ever sees. Phaser's own record
    // of the button is the backstop, so a drag cannot outlive the hand holding it.
    if (!pointer.isDown || !pointer.leftButtonDown()) {
      this.endDrag();
      return;
    }

    // Below the threshold the press is still just the click that already went out on press.
    if (!this.dragSteering) {
      if (now - this.dragPressedAt < DRAG_HOLD_MS) return;
      this.dragSteering = true;
      // Holding means the player is steering by hand, so the route the press fired has to go. Both
      // halves are set: `stop` tells the server, `serverWalking` stops this client zeroing its own
      // intent while it waits to be told what it already knows.
      this.net.send({ t: 'stop' });
      this.serverWalking = false;
    }

    const self = this.selfId === undefined ? undefined : this.entities.get(this.selfId);
    if (!self) return;

    // Steered from the *predicted* position, which is where the character is drawn. Using the server
    // position instead would aim from where they were a fraction of a second ago and make the
    // heading visibly lag the cursor at close range.
    //
    // Deliberately no `overUiPanel` check: dragging the cursor across the HUD is still a direction,
    // and a joystick that went dead over a panel would stick every time the pointer crossed one. The
    // panels only suppress the *press*, where the question is which tile was clicked.
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const intent = normaliseIntent(world.x - self.x, world.y - self.y);
    // Rounded, so a motionless pointer produces a byte-identical heading frame after frame and the
    // intent is sent once rather than sixty times a second. See {@link DRAG_HEADING_STEPS}.
    this.dragIntentX = Math.round(intent.x * DRAG_HEADING_STEPS) / DRAG_HEADING_STEPS;
    this.dragIntentY = Math.round(intent.y * DRAG_HEADING_STEPS) / DRAG_HEADING_STEPS;
  }

  /**
   * Sends one `moveTo`, and remembers where on screen it was asked for.
   *
   * `dragging` changes one thing: a re-path that the server is certain to refuse is **not sent at
   * all**. The server answers those with a `log` line as well as a `pathFailed`, and that line is
   * right for a click and unreadable for a drag, where a held pointer asks again eight times a
   * second for as long as the button is down.
   *
   * This is not the client deciding where it may walk. Both halves of {@link sendableDestination}
   * are gates the server applies itself, from data it sent here — the `seen` bitset and the tilemap
   * built from the `zone` message — so declining to ask a question whose answer is already in hand
   * cannot grant anything the server would not. Worst case the copy is one tick stale at the very
   * edge of the torchlight and a legal destination waits {@link DRAG_REPATH_MS} for the next sweep
   * to ask again. A plain click is never filtered, so the refusal — and the server's sentence
   * explaining it — still happens where it is wanted.
   */
  private requestMoveTo(worldX: number, worldY: number, dragging: boolean): void {
    const grid = this.grid;
    if (!grid) return;

    const tx = Math.floor(worldX / TILE_SIZE);
    const ty = Math.floor(worldY / TILE_SIZE);
    // Set before the gate below, so a locally-declined drag flashes where the pointer actually is.
    this.lastClick = { x: worldX, y: worldY };

    if (dragging && !this.sendableDestination(grid, tx, ty)) {
      this.flashDeniedThrottled(worldX, worldY);
      return;
    }
    this.net.send({ t: 'moveTo', tx, ty });
  }

  /**
   * Whether a *drag* re-path to this tile is worth sending. Both halves are refusals the server
   * would make anyway; the point is to make them silently rather than eight sentences a second.
   *
   * The walkability half is not redundant with the `seen` half, and leaving it out was a real hole.
   * `computeVisible` reveals an opaque tile whenever a ray touches it — walls are lit, they simply
   * do not transmit — so **void tiles enter `seen` like any other**: standing in a doorway at a
   * bare radius of 3 marks six of them. Dragging the cursor along the edge of a room or out towards
   * an exit, which is the ordinary way to aim at one, therefore cleared the `seen` gate on every
   * sweep, and the server answered each with `not-walkable` *and* "There is nothing to walk on
   * there." The ring was throttled and the log line was not, so the two channels disagreed and the
   * panel filled with a sentence the player had done nothing unusual to earn.
   */
  private sendableDestination(grid: TileGrid, tx: number, ty: number): boolean {
    return this.knownGround(grid, tx, ty) && isWalkable(tileAt(grid, tx, ty));
  }

  /**
   * Whether this character has seen a tile, per the server's own bitset.
   *
   * Answers `true` before the first snapshot arrives: with nothing authoritative to consult, the
   * right move is to ask the server rather than to invent a refusal.
   */
  private knownGround(grid: TileGrid, tx: number, ty: number): boolean {
    const seen = this.seen;
    if (!seen) return true;
    if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return false;
    return bitsetHas(seen, ty * grid.width + tx);
  }

  /** Whether a canvas click landed underneath one of the DOM panels. See {@link UI_PANELS}. */
  private overUiPanel(pointer: Phaser.Input.Pointer): boolean {
    const rect = this.game.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (this.scale.width <= 0 || this.scale.height <= 0) return false;

    // Phaser reports the pointer in game units; the panels are laid out in CSS pixels.
    const clientX = rect.left + (pointer.x / this.scale.width) * rect.width;
    const clientY = rect.top + (pointer.y / this.scale.height) * rect.height;

    for (const id of UI_PANELS) {
      const element = document.getElementById(id);
      if (!element) continue;
      // Transformed box, so the collapsed log correctly measures as just its 26px bar.
      const box = element.getBoundingClientRect();
      if (clientX >= box.left && clientX < box.right && clientY >= box.top && clientY < box.bottom) {
        return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------ route display */

  private createPathLayer(): void {
    this.pathLine = this.add.graphics().setDepth(PATH_DEPTH);
    this.pathMarker = this.add
      .circle(0, 0, 7)
      .setStrokeStyle(2, PATH_COLOUR, 0.95)
      .setDepth(PATH_DEPTH)
      .setVisible(false);
    // A slow pulse, so the destination reads as a live order rather than a decal on the map.
    this.tweens.add({
      targets: this.pathMarker,
      scale: { from: 0.8, to: 1.3 },
      duration: 640,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  /** Draws the server's route. An empty array clears it — that is the protocol's "no path". */
  private drawPath(points: readonly TilePoint[]): void {
    const line = this.pathLine;
    const marker = this.pathMarker;
    if (!line || !marker) return;

    line.clear();
    const destination = points[points.length - 1];
    if (!destination) {
      marker.setVisible(false);
      return;
    }

    if (points.length > 1) {
      line.lineStyle(2, PATH_COLOUR, 0.7);
      line.beginPath();
      let started = false;
      for (const point of points) {
        const x = tileCentre(point.tx);
        const y = tileCentre(point.ty);
        if (started) line.lineTo(x, y);
        else {
          line.moveTo(x, y);
          started = true;
        }
      }
      line.strokePath();
    }

    marker.setPosition(tileCentre(destination.tx), tileCentre(destination.ty)).setVisible(true);
  }

  /**
   * Shows *where* a click was refused. Deliberately says nothing about why.
   *
   * The server already sends a `log` line alongside every `pathFailed`, and it is the authority on
   * the reason — it is the only side that ran the search. This client used to write its own line as
   * well, so a player who clicked into the dark read two differently-worded sentences about one
   * click. One refusal, one sentence: the server's. What is left here is the half the server cannot
   * do, because it does not know where on screen the pointer was.
   *
   * The route already drawn is deliberately left alone: a refused destination does not cancel the
   * one the character is still walking.
   */
  private reportPathFailure(): void {
    const click = this.lastClick;
    if (!click) return;
    // A drag refuses continuously; a click refuses once. Same ring, different rate — see
    // `DENIED_DRAG_MS`. The flash is kept in both cases: it is the only thing on screen saying the
    // ground under the cursor is not somewhere this character can go.
    if (this.dragPointer) this.flashDeniedThrottled(click.x, click.y);
    else this.flashDenied(click.x, click.y);
  }

  /** {@link flashDenied}, rate-limited so a continuous refusal reads as a pulse, not a pile-up. */
  private flashDeniedThrottled(x: number, y: number): void {
    const now = this.time.now;
    if (now - this.deniedFlashAt < DENIED_DRAG_MS) return;
    this.deniedFlashAt = now;
    this.flashDenied(x, y);
  }

  /** A short warning pulse where the click landed, so a refusal is seen as well as read. */
  private flashDenied(x: number, y: number): void {
    const ring = this.add
      .circle(x, y, 9, DENIED_COLOUR, 0.18)
      .setStrokeStyle(2, DENIED_COLOUR, 0.9)
      .setDepth(PATH_DEPTH);
    this.tweens.add({
      targets: ring,
      scale: 2.1,
      alpha: 0,
      duration: DENIED_MS,
      ease: 'Quad.easeOut',
      onComplete: () => ring.destroy(),
    });
  }

  /* ------------------------------------------------------------------ zone */

  /**
   * Draws one Place — a zone at one vertical level.
   *
   * Called on join, on reconnect, and on every arrival at a new Place. Crossing a zone border and
   * taking a staircase are the same event as far as this method is concerned: both mean "the map
   * under your feet has been replaced". Nothing here distinguishes them.
   *
   * What survives a rebuild: the local player's entity along with the camera follow that targets it,
   * and the light radius, which is a property of the character rather than of the map. What does
   * not: the map texture, the room labels, the fog layer, every other entity, and the `seen` bitset —
   * which is per Place and is re-sent by the server for the one being arrived at.
   */
  private buildZone(zone: Zone, level: number): void {
    const place: Place = { zone: zone.id, level };
    const previous = this.place;
    this.place = place;
    // Kept, not just consumed: `roomLightTiles` walks the room graph every time a beacon's lit set
    // is recomputed, and the room graph is only ever stated in this message.
    this.zone = zone;

    // Everyone else was in the Place we just left. Leaving them on the display list strands them as
    // ghosts standing on a map that no longer exists. The local player is kept, because it is the
    // camera's follow target and destroying it would silently drop the follow.
    this.clearEntities(true);
    this.pendingArrival = true;
    // Arriving means the server relocated us, which zeroed the intent it holds. Whatever is being
    // held down has to be stated again or the character stands still while this client predicts it
    // walking. See `resendIntent`.
    this.resendIntent = true;

    // The route was drawn in the old map's pixels, which mean nothing here. The server sends a fresh
    // `path` if it is still walking us somewhere.
    this.drawPath([]);
    this.serverWalking = false;
    this.lastClick = undefined;
    // A drag in flight was aimed at pixels on the map that has just been replaced. Ending it means
    // the button has to be pressed again to resume following, which is right — the pointer is over
    // somewhere entirely different now, and nobody asked to walk there.
    this.endDrag();

    // Free the previous Place's render objects. See `placeObjects` for why `children.removeAll`
    // is not the tool for this.
    for (const object of this.placeObjects) object.destroy();
    this.placeObjects = [];
    this.roomLabels = [];
    if (this.textures.exists('fog')) this.textures.remove('fog');
    this.fogTexture = undefined;
    this.fogBuffer = undefined;
    this.fogScratch = undefined;
    this.mapTexture = undefined;

    // Emptied with the map it belongs to. A portal remembered across a Place change would be a click
    // target floating over a level that never had it.
    this.portals = [];
    this.grid = buildZoneTilemap(zone, level);
    const grid = this.grid;

    const width = grid.width * TILE_SIZE;
    const height = grid.height * TILE_SIZE;

    // `seen` is indexed by tile, so it belongs to one Place and one grid size. A different map
    // therefore starts blank and waits for its own `seen` message.
    //
    // The exception is a `zone` for the Place already drawn, which is a resync rather than travel:
    // keeping the bitset there means the deltas received since the last snapshot are not dropped on
    // the floor, leaving ground the character has walked painted black until it is walked again.
    const tileCount = grid.width * grid.height;
    const resync = previous !== undefined && samePlace(previous, place);
    if (!resync || this.seen?.length !== bitsetBytes(tileCount)) {
      this.seen = createBitset(tileCount);
      this.applySeenSnapshot();
    }
    // The lit set was computed against the old map's tile indices, which address nothing here.
    this.clearVisible();

    // Static geometry, so it is stamped once into a single texture rather than kept as ~10,000
    // game objects.
    const map = this.add.renderTexture(0, 0, width, height).setOrigin(0, 0).setDepth(0);
    map.beginDraw();
    for (let ty = 0; ty < grid.height; ty++) {
      for (let tx = 0; tx < grid.width; tx++) {
        const index = ty * grid.width + tx;
        const tile = grid.tiles[index] ?? Tile.Void;
        if (tile === Tile.Void) continue;
        const art = this.artFor(tile, grid.sectors[index] ?? 3);
        const frame = art.frames[hashTile(tx, ty) % art.frames.length] ?? 10;
        map.batchDrawFrame(art.sheet, frame, tx * TILE_SIZE, ty * TILE_SIZE, 1, art.tint ?? 0xffffff);
      }
    }
    map.endDraw();
    this.placeObjects.push(map);
    // Destroyed with the rest of `placeObjects` on the next Place change; this is a second reference
    // to the same object, for the door repaint.
    this.mapTexture = map;

    // Faint room names, so the MUD's geography is legible while exploring. `roomOrigins` holds only
    // the rooms on *this* level, so the other levels' rooms fall out here rather than being stacked
    // on top of this map at coordinates that belong to a different Place.
    for (const room of zone.rooms) {
      const origin = grid.roomOrigins.get(room.id);
      if (!origin) continue;
      const label = this.add
        .text(
          (origin.tx + ROOM_TILES / 2) * TILE_SIZE,
          (origin.ty + ROOM_TILES / 2) * TILE_SIZE,
          room.name,
          { fontFamily: 'Consolas, monospace', fontSize: '10px', color: '#e6e0cf', align: 'center' },
        )
        .setOrigin(0.5)
        .setAlpha(0.42)
        .setDepth(1)
        .setWordWrapWidth(ROOM_TILES * TILE_SIZE - 8);
      this.placeObjects.push(label);
      this.roomLabels.push(label);

      // **Portals, drawn on the wall they leave through.** Owner-reported twice: a mob fled east out
      // of a room whose only visible opening was north, which read as the game moving a body through
      // a wall. A portal is a real exit whose destination is not the geometric neighbour, so the
      // tilemap carves no opening for it and the wall stays solid — 6.1% of the world's exits. It is
      // reachable by typing the direction and by nothing else, which makes it a secret by accident
      // rather than by design. A marker makes it an exit you can see and click.
      for (const [dir, exit] of Object.entries(room.exits ?? {})) {
        if (!exit?.portal) continue;
        this.placeObjects.push(this.makePortalMarker(origin, dir as Direction, room.id));
      }
    }
    // Labels built while zoomed out must start hidden, not appear for one frame and then vanish.
    this.applyLabelVisibility(ZOOM_STEPS[this.zoomStep] ?? 1);

    this.createFog(grid, width, height);

    // Bounds and framing are per-Place: the new map is a different size, and a zoomed-out view was
    // centred on the old one. `frameCamera` sets the bounds, because how far the camera may scroll
    // depends on the zoom as well as on the map — see `applyCameraBounds`.
    this.frameCamera();

    setText('hud-zone', zoneLabel(zone, level));
    this.announceArrival(zone, place, previous, grid.roomOrigins.size);
  }

  /** The log line that makes travel obvious: which Place, and whether it is new. */
  private announceArrival(
    zone: Zone,
    place: Place,
    previous: Place | undefined,
    roomsHere: number,
  ): void {
    if (previous === undefined) {
      this.log.write('system', `${zone.name} — ${roomsHere} rooms on this level.`);
    } else if (!samePlace(previous, place)) {
      const how =
        previous.zone === place.zone
          ? `You pass onto another level of ${zone.name}`
          : `You cross into ${zone.name}`;
      this.log.write('system', `${how} — ${roomsHere} rooms on this level.`);
    } else {
      // A `zone` for the Place already drawn is a resync, not travel. Redraw, but say nothing — and
      // in particular do not flash a card, which is the case V5 most obviously must not fire on:
      // A5's terrain edit and A8's regrid both resend the Place you are standing in.
      return;
    }

    // **V5, on exactly the two occasions the log line is written and no others.** Both are arrivals:
    // one is walking into somewhere new, and the other is logging in, which is arriving as far as the
    // player is concerned. The level count comes from the `Zone` the client already holds, so a
    // one-level place says its name and nothing else.
    const levels = new Set(zone.rooms.map((room) => room.pos.z)).size;
    this.arrival?.show(zone.name, place.level, levels);
  }

  /* ------------------------------------------------------------- fog of war */

  /**
   * Builds the fog overlay for one Place.
   *
   * The overlay is one pixel per *tile* of this grid, so it cannot be reused across Places — a new
   * map is a different size. It is rebuilt here and torn down by `buildZone`; only the `seen` bitset
   * it is painted from persists, and only for as long as the Place does.
   */
  private createFog(grid: TileGrid, width: number, height: number): void {
    // One pixel per tile. Tiny to repaint, and the upscale is what makes the edge soft.
    const texture = this.textures.createCanvas('fog', grid.width, grid.height);
    if (!texture) return;
    // The game runs in pixelArt mode, which defaults every texture to NEAREST. The fog is the one
    // layer that must be filtered smoothly, so it opts back in explicitly.
    texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.fogTexture = texture;

    const scratch = document.createElement('canvas');
    scratch.width = grid.width;
    scratch.height = grid.height;
    this.fogScratch = scratch;
    this.fogBuffer = new ImageData(grid.width, grid.height);

    const overlay = this.add
      .image(0, 0, 'fog')
      .setOrigin(0, 0)
      .setDisplaySize(width, height)
      .setDepth(50);
    this.placeObjects.push(overlay);

    // Painted now rather than marked dirty. A fresh canvas texture is fully transparent, which is
    // this overlay's "everything is lit" — deferring even one frame flashes the whole map.
    this.paintFog();
  }

  /**
   * Paints the three visibility states, one pixel per tile.
   *
   * Driven by {@link fogDirty}, so it runs when the lit set moves or newly-seen tiles arrive and not
   * otherwise. Walking crosses a tile boundary about five times a second and the server batches
   * deltas onto the 100 ms tick, so this is an order of magnitude rarer than the render loop even at
   * a dead sprint.
   *
   * Only the alpha channel is touched. The buffer is allocated zeroed and lives as long as the
   * Place, so RGB stays black without being written 26,000 times a repaint.
   */
  private paintFog(): void {
    this.fogDirty = false;

    const grid = this.grid;
    const texture = this.fogTexture;
    const buffer = this.fogBuffer;
    const scratch = this.fogScratch;
    if (!grid || !texture || !buffer || !scratch) return;

    const data = buffer.data;
    const seen = this.seen;
    const visible = this.visible;
    const count = grid.width * grid.height;

    // Lit beats remembered beats unknown. A tile can be lit without yet being in `seen` — this
    // client predicts ahead of the server by a tile or so — and drawing it lit is right: the
    // authoritative delta for it is already on its way.
    for (let index = 0; index < count; index++) {
      data[index * 4 + 3] = visible.has(index)
        ? FOG_LIT
        : seen && bitsetHas(seen, index)
          ? this.rememberedAlpha
          : FOG_UNKNOWN;
    }

    const scratchCtx = scratch.getContext('2d');
    if (!scratchCtx) return;
    scratchCtx.putImageData(buffer, 0, 0);

    const ctx = texture.getContext();
    ctx.clearRect(0, 0, grid.width, grid.height);
    ctx.filter = `blur(${FOG_BLUR}px)`;
    ctx.drawImage(scratch, 0, 0);
    ctx.filter = 'none';
    texture.refresh();
  }

  /**
   * Decodes the held `seen` snapshot into the bitset, if it describes the Place now drawn.
   *
   * A snapshot for a different Place is left held rather than discarded: it may simply have arrived
   * before the `zone` that gives it a grid to be indexed against, and this is the only code that
   * knows the size that grid makes it. The byte length comes from the grid rather than from the
   * string, so a short or corrupt one leaves the rest of the map unseen instead of throwing.
   */
  private applySeenSnapshot(): void {
    const grid = this.grid;
    const place = this.place;
    const snapshot = this.seenSnapshot;
    if (!grid || !place || !snapshot || !samePlace(snapshot.place, place)) return;
    this.seen = bitsFromBase64(snapshot.bits, bitsetBytes(grid.width * grid.height));
    this.invalidateFog();
  }

  /**
   * Recomputes the lit set when the predicted position crosses a tile boundary.
   *
   * Locally, and from the *predicted* position, because this layer has to be perfectly smooth and is
   * cosmetic — being a frame or a pixel out of step with the server does not matter, and waiting a
   * round trip to light the ground underfoot would. `seen` is the exact opposite and is never
   * computed here.
   *
   * It is the same `computeVisible` the server runs, so the edge of the torchlight agrees with the
   * ground the server will actually let this character walk on.
   *
   * ## Two illumination modes, not one number
   *
   * A `'rooms'`-mode source is a magical beacon: it lights every tile of every room within its
   * radius *in room-steps through the room graph*, walls and corners included, and no field-of-view
   * cast produces that shape. `SelfView.lightRadius` for a beacon is only a tile-distance floor —
   * painting a disc of it would show a circle where the server has lit whole rooms, and the fog
   * would disagree with the ground the server lets you click on. So the mode chooses the function,
   * and both sides call the same one.
   */
  private refreshVisible(): void {
    const grid = this.grid;
    if (!grid) return;
    const self = this.selfId === undefined ? undefined : this.entities.get(this.selfId);
    if (!self) return;

    const tx = Math.floor(self.x / TILE_SIZE);
    const ty = Math.floor(self.y / TILE_SIZE);

    // A beacon's lit set is a property of the room, and the room is only ever entered by crossing a
    // tile — so keeping the tile in the key costs at most one extra room-graph walk per crossing and
    // cannot miss a change. `zone` and the room id are both needed before the beacon can be drawn at
    // all; without either, the disc is the safe answer rather than nothing.
    const light = this.carriedLight;
    const zone = this.zone;
    const beaconRoom =
      light && light.mode === 'rooms' && zone !== undefined ? this.selfRoomId : undefined;

    // The room is in the key as well as the tile. Crossing a room boundary always crosses a tile, so
    // this cannot *miss* a change — but a server correction can move `selfRoomId` without the predicted
    // tile moving, and a natural-light set keyed on the tile alone would then describe the room behind.
    if (
      tx === this.visibleTx &&
      ty === this.visibleTy &&
      beaconRoom === this.visibleRoom &&
      this.selfRoomId === this.visibleNaturalRoom
    ) {
      return;
    }

    this.visibleTx = tx;
    this.visibleTy = ty;
    this.visibleRoom = beaconRoom;
    this.visibleNaturalRoom = this.selfRoomId;
    const lit =
      zone !== undefined && light !== undefined && beaconRoom !== undefined
        ? roomLightTiles(grid, zone, beaconRoom, light.radius)
        : computeVisible(grid, tx, ty, this.lightRadius);
    // **A room that lights itself, unioned in — the same shared derivation the server folds into `seen`.**
    // Both sides call `naturalLightTiles` for the reason both already call `computeVisible`: a tile the two
    // disagree about is ground the player can see and cannot walk to. Copied into a fresh set rather than
    // mutated, because `roomLightTiles` and `computeVisible` both hand back sets this frame owns — and the
    // union is skipped entirely for a dark room, which is what the whole model was built for.
    const room = zone?.rooms.find((r) => r.id === this.selfRoomId);
    this.visible =
      zone !== undefined && this.selfRoomId !== undefined && roomLightsItself(room)
        ? new Set([...lit, ...naturalLightTiles(grid, zone, this.selfRoomId)])
        : lit;
    this.invalidateFog();
  }

  /** Drops the lit set and forces a recompute next frame. The map or the light has changed under it. */
  private clearVisible(): void {
    this.visible = new Set();
    this.visibleTx = undefined;
    this.visibleTy = undefined;
    this.visibleRoom = undefined;
  }

  /** Marks the overlay for a repaint on the next frame. See {@link fogDirty}. */
  private invalidateFog(): void {
    this.fogDirty = true;
  }

  /**
   * The character's light changed — a torch picked up, a spell cast, a Beacon burned out.
   *
   * Nothing here decides what it should be; the server does, and this only mirrors it. The lit set
   * is invalidated rather than recomputed, so several messages in one tick cost one recompute on the
   * next frame instead of one each.
   *
   * Both halves in one call because they are one fact arriving in one message, and changing either
   * can change the picture: the radius is what `computeVisible` casts to, and the *mode* decides
   * whether that is the function being called at all.
   */
  private applyLight(radius: number, light: CarriedLight | undefined): void {
    const changed =
      radius !== this.lightRadius ||
      light?.id !== this.carriedLight?.id ||
      light?.mode !== this.carriedLight?.mode ||
      light?.radius !== this.carriedLight?.radius;

    this.lightRadius = radius;
    this.carriedLight = light;
    // Recomputed from scratch every time rather than only when it looks like it moved: the server
    // is the authority on how long is left, and any drift this clock has accumulated since the last
    // message ends here. A source that never expires clears the deadline outright.
    this.lightDeadline =
      light?.remainingMs === undefined ? undefined : this.time.now + light.remainingMs;

    if (changed) this.clearVisible();
  }

  /** Mirrors the server's idea of which room this character is in. See {@link selfRoomId}. */
  private setSelfRoom(roomId: RoomId): void {
    if (roomId === this.selfRoomId) return;
    this.selfRoomId = roomId;
    // Only a beacon reads it, and only then is the lit set wrong until it is recomputed. Cheaper to
    // test the mode than to throw away a disc that is still perfectly correct.
    if (this.carriedLight?.mode === 'rooms') this.clearVisible();
  }

  /**
   * The light line of the HUD: the radius, what is producing it, and how long that has left.
   *
   * The clock counts down *here*, from a deadline, rather than waiting to be told. The server sends
   * `remainingMs` when something changes and would have to send it sixty times a second for this to
   * be smooth otherwise; between messages this is interpolation, and every `self` overwrites it.
   *
   * Called every frame and writes the DOM only when the sentence changes, which is once a second
   * for most of a torch's life and ten times a second in its last few. The key is the whole visible
   * string, so nothing can change without the panel following it.
   */
  private refreshLightHud(now: number): void {
    const light = this.carriedLight;
    const remaining =
      this.lightDeadline === undefined ? undefined : Math.max(0, this.lightDeadline - now);

    // A `rooms` source is quoted in rooms. Its `lightRadius` is a tile-distance floor chosen so that
    // consumers which only understand a disc are not handed a downgrade — printing it would tell the
    // player they can see 11 tiles when what they can actually see is a block of rooms.
    const radius =
      light?.mode === 'rooms'
        ? `light ${light.radius} room${light.radius === 1 ? '' : 's'}`
        : `light ${this.lightRadius}`;
    const source = light ? ` · ${light.name}` : '';
    const clock = remaining === undefined ? '' : ` · ${formatRemaining(remaining)}`;

    const key = `${radius}${source}${clock}`;
    if (key === this.lightHudKey) return;
    this.lightHudKey = key;

    setText('hud-light-radius', radius);
    // **Painted, not assigned** — found while taking the light out of the main hand (2026-08-06): a
    // wielded redwood torch read `&+ra redwo&+yod torc&+Yh&N` in the HUD while the paper doll three
    // inches away rendered it correctly. An item's name is *authored text* and carries the MUD's own
    // colour codes; V6 made every DOM surface paint them and this line was missed, because the six
    // hand-authored lights `pickups.ts` scatters have no codes in them and the catalogue's 64 do.
    const sourceCell = document.getElementById('hud-light-source');
    if (sourceCell) {
      if (light) paint(sourceCell, ` · ${light.name}`);
      else sourceCell.textContent = '';
    }
    setText('hud-light-remaining', clock);

    const element = document.getElementById('hud-light');
    if (!element) return;
    const urgent = remaining !== undefined && remaining <= LIGHT_URGENT_MS;
    element.classList.toggle('urgent', urgent);
    element.classList.toggle('warn', !urgent && remaining !== undefined && remaining <= LIGHT_WARN_MS);
  }

  /**
   * The timed effects on this character, turned into deadlines against the scene clock.
   *
   * The server sends the whole list every time any of it changes, so this replaces rather than merges —
   * an effect that has lapsed is simply absent from the next message, and reconciling additions and
   * removals by hand would be a second copy of a decision the server has already made.
   *
   * Grouping and hiding both happened server-side (`summariseAffects`): what arrives is one row per
   * cause with the `NoShow` ones already gone, so there is nothing to filter here and no way for the
   * two ends to disagree about what is shown.
   */
  private applyAffects(affects: readonly AffectView[]): void {
    const now = this.time.now;
    this.affects = affects.map((affect) => ({
      type: affect.type,
      name: affect.name,
      endsAt: affect.remainingMs === undefined ? undefined : now + affect.remainingMs,
    }));
  }

  /**
   * The affects panel: one line per effect, with its own countdown.
   *
   * Called every frame and writes the DOM only when the rendered text changes — which for a
   * minute-long effect is once a second. The key is the whole visible string, exactly as the light
   * line's is, so nothing can change without the panel following it.
   *
   * The panel is built as text rather than as elements per row. There are never more than a handful of
   * rows, and `textContent` on one node is both cheaper and impossible to leak: a row-per-element
   * approach has to remove the elements for effects that ended, and that is the bug this avoids by
   * construction.
   */
  private refreshAffectsHud(now: number): void {
    const lines = this.affects.map((affect) => {
      if (affect.endsAt === undefined) return affect.name;
      return `${affect.name} · ${formatRemaining(Math.max(0, affect.endsAt - now))}`;
    });

    const key = lines.join('\n');
    if (key === this.affectsHudKey) return;
    this.affectsHudKey = key;

    const element = document.getElementById('hud-affects');
    if (!element) return;
    element.textContent = key;
  }

  /**
   * Whether a world-pixel position is lit right now.
   *
   * Terrain is remembered, creatures are not: this is what keeps a mob that wandered into a room the
   * character merely remembers off the screen until light falls on it again.
   */
  /**
   * The character's own posture and status, as the HUD reads them and as prediction gates on them.
   *
   * Shown only when it is *news*. Standing and normal is the whole of the game so far, and a HUD line
   * reading "standing · normal" at all times is furniture the eye learns to skip — which is precisely
   * the state in which it fails to notice the line that matters.
   */
  private applyStance(posture: Posture, status: Status): void {
    this.canMovePredicted = posture === 'standing' && status === 'normal';

    const element = document.getElementById('hud-stance');
    if (!element) return;
    const notable = !this.canMovePredicted;
    element.textContent = notable ? describeStance({ posture, status }).replace(/^is /, '') : '';
    element.classList.toggle('notable', notable);
  }

  /**
   * The three pools, as bars and numbers.
   *
   * Width in per cent rather than pixels so the CSS transition does the interpolation: the server
   * sends a `self` only when a pool actually moves, which at regeneration rates is every few seconds,
   * and a bare assignment would make each point a visible jump. Letting the browser ease it turns the
   * same messages into something that reads as healing.
   *
   * Hit points can go *negative* — that is the dying window — so the bar clamps at zero while the
   * number keeps telling the truth. A bar that vanished and a number that said `-4` is more
   * informative than either alone.
   */
  private applyPools(view: SelfView): void {
    const pools = [
      { key: 'hp', current: view.hp, max: view.maxHp },
      { key: 'mana', current: view.mana, max: view.maxMana },
      { key: 'move', current: view.move, max: view.maxMove },
    ] as const;

    for (const { key, current, max } of pools) {
      const bar = document.getElementById(`bar-${key}`);
      const num = document.getElementById(`num-${key}`);
      const fraction = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
      if (bar) bar.style.width = `${(fraction * 100).toFixed(1)}%`;
      if (num) num.textContent = `${Math.round(current)}/${Math.round(max)}`;

      // Only hit points get the warning colours; running out of breath is not an emergency.
      const row = bar?.closest('.pool');
      if (row && key === 'hp') {
        row.classList.toggle('low', fraction <= 0.5 && fraction > 0.25);
        row.classList.toggle('critical', fraction <= 0.25);
      }
    }

    this.applyExperience(view);
  }

  /**
   * Progress toward the next level.
   *
   * **Not folded into the pool loop above**, though it wears the same row: the loop's warning colours,
   * its dying-window clamp and its "current out of max" reading are all pool semantics, and experience
   * has none of them. It cannot fall, it cannot kill you, and its maximum moves every level.
   *
   * The denominator is reconstructed rather than sent. `SelfView` carries what is banked and what is
   * still needed, and Duris' curve is *subtractive* — experience is a running balance toward the next
   * level, not a lifetime total — so the two already add up to the cost of this level. Shipping the
   * cost as a third field would be shipping a sum of two numbers already on the wire.
   *
   * Until Phase 14b this was worth nothing: the server sent a hardcoded `300` because experience was
   * banked and never spent. It buys levels now, so it is worth drawing.
   */
  private applyExperience(view: SelfView): void {
    const bar = document.getElementById('bar-xp');
    const num = document.getElementById('num-xp');
    if (!bar && !num) return;

    // At the ceiling there is no next level, and `experienceToNext` is 0 — which through the
    // arithmetic below would read as a full bar about to tip over. It is the opposite: nothing more
    // to earn. Said in words, because a bar cannot say "done" and a full one says "imminent".
    if (view.level >= MAX_LEVEL) {
      if (bar) bar.style.width = '100%';
      if (num) num.textContent = 'max';
      return;
    }

    const cost = view.experience + view.experienceToNext;
    const fraction = cost > 0 ? Math.max(0, Math.min(1, view.experience / cost)) : 0;
    if (bar) bar.style.width = `${(fraction * 100).toFixed(1)}%`;
    if (num) num.textContent = `${Math.round(view.experience)}/${Math.round(cost)}`;
  }

  private litAt(x: number, y: number): boolean {
    const grid = this.grid;
    if (!grid) return false;
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return false;
    return this.visible.has(ty * grid.width + tx);
  }

  /**
   * A door on this map opened or shut.
   *
   * The grid is patched with the *same* `setDoorTiles` the server ran, not with a local guess at what
   * a door means — a shut door is not walkable, so a client whose copy of that tile is wrong predicts
   * the character straight through a wall the server will hold them at, and reconciliation drags them
   * back every frame.
   *
   * Repainting is the tiles it actually changed and no more. It is also why the terrain texture is
   * kept: rebuilding the Place would work and would throw away the fog, the camera framing and every
   * room label to redraw six tiles.
   */
  private applyDoor(roomId: RoomId, dir: Direction, closed: boolean): void {
    const grid = this.grid;
    if (!grid) return;
    const changed = setDoorTiles(grid, roomId, dir, closed);
    if (changed.length === 0) return;

    const map = this.mapTexture;
    if (map) {
      map.beginDraw();
      for (const index of changed) {
        const tx = index % grid.width;
        const ty = Math.floor(index / grid.width);
        const art = this.artFor(grid.tiles[index] ?? Tile.Void, grid.sectors[index] ?? 3);
        const frame = art.frames[hashTile(tx, ty) % art.frames.length] ?? 10;
        map.batchDrawFrame(art.sheet, frame, tx * TILE_SIZE, ty * TILE_SIZE, 1, art.tint ?? 0xffffff);
      }
      map.endDraw();
    }

    // A shut door is opaque, so the lit set is stale even though nobody moved. The server has already
    // recomputed its own and will ship any newly-seen tiles; this is the local disc, which is
    // recomputed every frame from `lightRadius` — so only the fog needs waking.
    this.invalidateFog();
  }

  private artFor(tile: number, sector: number): TileArt {
    switch (tile) {
      case Tile.Connector:
        return CONNECTOR_ART;
      case Tile.Door:
        return DOOR_ART;
      case Tile.DoorOpen:
        return OPEN_DOOR_ART;
      case Tile.StairsUp:
        return STAIRS_UP_ART;
      case Tile.StairsDown:
        return STAIRS_DOWN_ART;
      default:
        return SECTOR_ART[sector] ?? FALLBACK_ART;
    }
  }

  /* -------------------------------------------------------------- entities */

  private upsertEntity(view: EntityView): void {
    const isSelf = view.id === this.selfId;

    const existing = this.entities.get(view.id);
    if (existing) {
      // **A changed outfit redraws the body — the missing quarter of the kit pipeline.** The server
      // pushes an `entityUpdate` on every kit change and this branch used to keep the new `wearing`
      // and rebuild nothing, so a shield went on, the panel doll showed it, every argument
      // downstream was correct — and the body on screen kept its old clothes until some membership
      // event happened to rebuild it. Found chasing the owner's "it is not loading the sprite for
      // the shield I am wearing" (2026-08-07), the last of four gaps between `wear` and the pixels.
      const wornChanged = view.kind !== 'item' && !sameWearing(existing.view.wearing, view.wearing);
      existing.view = view;
      existing.serverX = view.x;
      existing.serverY = view.y;
      if (isSelf && this.pendingArrival) {
        // First position on a new map. The rendered position is still the old Place's pixels, which
        // mean nothing here, so hard-set it instead of letting the reconciler ease toward it.
        existing.x = view.x;
        existing.y = view.y;
        existing.container.setPosition(view.x, view.y);
        this.pendingArrival = false;
      }
      if (wornChanged) this.redressEntity(existing);
      this.faceEntity(existing, view.facing);
      this.refreshHealthBar(existing);
      return;
    }

    const isItem = view.kind === 'item';

    // A ground item is one image; a body is a stack of LPC layers. Both end up as children of the same
    // container, so everything downstream — movement, the visibility gate, the label — is unchanged.
    const layers: Phaser.GameObjects.Image[] = isItem
      ? this.itemLayers(view.sprite)
      : this.characterLayers(view.sprite, view.facing, view.wearing);

    // **"This one is you", on the floor rather than over the head.** The LPC sprite already *shows* its
    // facing — that is what the four sheet rows are — so the old pip's first job was done by the art and
    // it survived only as a self-marker. Owner's call (2026-08-04): it was a square hanging at y −46,
    // which is exactly `MARKER_HEIGHT`, so the moment the target chevron arrived there were two small
    // pale shapes floating at the same altitude in the same gold and the pip read as a marker for
    // something. The airspace over a head now belongs to the chevron alone.
    //
    // Shaped *against* the click-to-move destination marker, which is the same `0xffe9a8` and also on the
    // ground: that one is a **stroked true circle of radius 7 that pulses**. This is a wide flat filled
    // ellipse that never moves. Colour is the one thing they share, and deliberately — gold already means
    // "yours" on your name label, so keeping it is one fewer idiom to learn.
    //
    // The container's origin is the character's feet (`LPC_FOOT_OFFSET` lifts the art off it), so local
    // (0, 0) *is* the ground the boots are standing on. No offset to keep in step with the sprite scale.
    // **Not at local y 0, despite that being the container's own origin.** An LPC frame is 64 tall with
    // the figure standing near its last row, so with the art hung at `LPC_FOOT_OFFSET` the boots land
    // around y +8 — a ring on the origin cuts the character across the thighs. This is the one place
    // that wants where the boots *are* rather than where the entity is said to be.
    const footprint = isItem || !isSelf
      ? undefined
      : this.add.ellipse(0, 8, 26, 10, 0xffe9a8, 0.1).setStrokeStyle(1.5, 0xffe9a8, 0.8);

    // A health bar for every body that is not you: a dark trough with a filled bar over it, both
    // origin-left so the fill shrinks from the right rather than from its middle. Drawn above the head
    // rather than under the feet so it cannot be confused with the target marker on the floor.
    const trough = isItem || isSelf ? undefined : this.add.rectangle(0, HEALTH_BAR_Y, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT, 0x1b1f18)
      .setOrigin(0.5, 0.5)
      .setStrokeStyle(1, 0x000000, 0.6);
    const health = isItem || isSelf ? undefined : this.add.rectangle(
      -HEALTH_BAR_WIDTH / 2, HEALTH_BAR_Y, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT, HEALTH_FULL,
    ).setOrigin(0, 0.5);
    // **Bodies are named on screen; things on the floor are not** — owner's call, 2026-08-05:
    // *"maybe not show the name of the object. just the graphic. people can look at it to see what it
    // is."*
    //
    // Right, and A7d is what earns it. The label used to be doing the identifying, because nine
    // category glyphs were shared between 16,421 catalogue entries and the picture could not tell a
    // rapier from a mace. Now it can, and the label went from useful to noise the moment three items
    // landed on one tile and their names overlapped into an unreadable smear. `look` is the verb for
    // *what exactly is this*, and it always was.
    const label = isItem
      ? undefined
      : this.add
          // **Stripped, not painted.** A Phaser text object renders one colour and cannot hold spans,
          // so the codes a harvested name carries have to come out or they print as
          // `&+ma steel long sword` over the thing's head. The DOM surfaces — the log, the character
          // sheet — paint instead.
          .text(0, 14, stripColour(view.name), {
            fontFamily: 'Consolas, monospace',
            fontSize: '11px',
            color: isSelf ? '#ffe9a8' : '#cfd8c0',
          })
          .setOrigin(0.5, 0);

    // **Behind the body, and it took two goes to land there.** Under it first, on the container origin:
    // the legs covered all but a sliver at each end, because the ring sat at the figure's *thighs* rather
    // than its feet — the origin is where the entity is, `LPC_FOOT_OFFSET` is where the art hangs, and the
    // boots are neither. Over it next, which showed the whole ellipse and drew a line straight across the
    // character. Owner's call (2026-08-04): behind, and lower. Dropped to the boot line it now reads as a
    // ring the character is standing *in* — the near arc in front of the feet, the far arc hidden by them,
    // which is the only arrangement of the two that looks like ground rather than paint.
    const parts: Phaser.GameObjects.GameObject[] = footprint ? [footprint, ...layers] : [...layers];
    if (trough && health) parts.push(trough, health);
    if (label) parts.push(label);
    const container = this.add
      .container(view.x, view.y, parts)
      .setDepth(isItem ? ITEM_DEPTH : ENTITY_DEPTH);

    // A slow bob, for the same reason the destination marker pulses: a still sprite on a still floor
    // reads as scenery, and this is a thing you can pick up by walking over it. The tween is held on
    // the entity because Phaser does not stop one when its target is destroyed, and this one repeats
    // forever — see `Entity.idle`.
    const idle = isItem
      ? this.tweens.add({
          targets: layers[0],
          y: { from: 0, to: -3 },
          duration: 900,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        })
      : undefined;

    const entity: Entity = {
      view,
      container,
      layers: isItem ? [] : layers,
      footprint,
      health,
      healthTrough: trough,
      idle,
      x: view.x,
      y: view.y,
      walked: 0,
      serverX: view.x,
      serverY: view.y,
    };
    this.faceEntity(entity, view.facing);
    this.refreshHealthBar(entity);
    this.entities.set(view.id, entity);
    // Decided here as well as in the loop so an unlit creature never flashes into view for the one
    // frame between being created and being gated.
    container.setVisible(isSelf || this.litAt(view.x, view.y));

    if (isSelf) {
      // Created straight onto the server's position, so there is nothing left to snap.
      this.pendingArrival = false;
      this.frameCamera();
    }
  }

  private removeEntity(id: EntityId): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    this.disposeEntity(entity);
    this.entities.delete(id);
  }

  /**
   * Frees everything one entity owns.
   *
   * The tween goes first and explicitly: `container.destroy(true)` frees the children it is playing
   * on, but Phaser leaves the tween itself running against the corpse. A ground item's bob repeats
   * forever, so every torch picked up over a session would leave one behind.
   */
  private disposeEntity(entity: Entity): void {
    entity.idle?.remove();
    this.forgetFollow(entity.container);
    // The chevron is positioned in world space rather than parented to the body, so destroying the
    // body leaves it hanging over empty floor. Hidden rather than cleared: `markerId` is still the
    // right answer — the quarry exists, it is simply somewhere this client cannot see — and `update`
    // brings it back the moment that body is rendered again.
    if (this.markerId === entity.view.id) this.marker?.setVisible(false);
    entity.container.destroy(true);
  }

  /**
   * Destroys tracked entities, optionally sparing the local player.
   *
   * Sparing it is what lets a Place change keep the camera follow: the follow holds a reference to
   * the container, so destroying and recreating it would leave the camera pointing at a dead object
   * until the next `room` message.
   */
  private clearEntities(keepSelf: boolean): void {
    for (const [id, entity] of this.entities) {
      if (keepSelf && id === this.selfId) continue;
      this.disposeEntity(entity);
      this.entities.delete(id);
    }
  }

  /** Drops the camera follow if it points at an object about to be destroyed. */
  private forgetFollow(container: Phaser.GameObjects.Container): void {
    if (this.followTarget === container) this.stopFollowing();
  }

  /**
   * Points a body the way the server says it is facing.
   *
   * Every layer is re-framed to the same row, because they share one geometry and a stack that
   * disagreed with itself would wear its head backwards. Ground items fall out on the empty layer list —
   * nothing filters them out before this, since `entityMoved` and every upsert run over whatever the
   * server sent, so the absence is handled here, once.
   */
  private faceEntity(entity: Entity, facing: Direction): void {
    // **Protocol 22: what the body is doing outranks how it is moving.** Each pose below is a
    // suffix-sheet swap guarded per layer on `textures.exists` — the idle swap's own contract — and
    // pose is *re-derived* on every call rather than transitioned, so an expired swing simply falls
    // through to whatever is still true: the wind-up loop, the ground, or the stride.
    const action = entity.action;
    if (action) {
      const elapsed = this.time.now - action.startedAt;
      const column = Math.min(Math.floor(elapsed / ACTION_FRAME_MS), ACTION_COLUMNS[action.suffix] - 1);
      this.poseLayers(entity, facing, action.suffix, column);
      return;
    }
    if (entity.view.casting) {
      // A held loop, not a one-shot: the server's flag opens it and its clearing closes it, which is
      // also exactly when the room hears the strike or the fizzle. Phased off wall time because the
      // chant has no start worth honouring — every caster in the room chanting in step reads as a
      // choir, which for a MUD is the right kind of wrong.
      this.poseLayers(entity, facing, CAST_SUFFIX, Math.floor(this.time.now / CAST_FRAME_MS) % CAST_COLUMNS);
      return;
    }
    if (entity.view.posture !== undefined && entity.view.posture !== 'standing') {
      // The promise protocol 8 wrote and nothing kept until now: a sleeping stranger looks asleep —
      // and a bashed one looks knocked to the ground, which is the sentence the room was told.
      this.poseLayers(entity, facing, DOWN_SUFFIX, 0);
      return;
    }
    // Standing and walking are different *sheets*, not different columns of one — see `IDLE_SUFFIX`.
    const standing = entity.walked === 0;
    const column = walkColumn(entity);
    for (const layer of entity.layers) {
      const walkSheet = layer.getData('sheet') as string | undefined;
      if (walkSheet) {
        // **Only if there is one.** The starter kit ships an idle sheet beside every walk sheet, so
        // this used to be a straight swap — and the day indexed art arrived, standing still turned
        // every authored sword into Phaser's `__MISSING` box, because `artgen` stages one walk sheet
        // per art id and nothing called `<id>-idle`. Standing on the walk sheet's own frame is a
        // perfectly good still pose; a missing texture is not.
        const idle = walkSheet + IDLE_SUFFIX;
        const wanted = standing && this.textures.exists(idle) ? idle : walkSheet;
        if (layer.texture.key !== wanted) layer.setTexture(wanted);
      }
      layer.setFrame(layerFrame(layer.texture, facing, column));
    }
  }

  /**
   * A blow's motion, restarted rather than queued when a second lands mid-swing — a haste fighter's
   * three attacks read as three restarts, which loses frames but never truth: every swing that
   * happened moved the body that made it. Queuing would still be playing round one during round two.
   */
  private playSwing(id: EntityId, swing: 'slash' | 'thrust'): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    entity.action = { suffix: ACTION_SUFFIXES[swing], startedAt: this.time.now };
    this.faceEntity(entity, entity.view.facing);
  }

  /**
   * One pose, every layer — the suffix-sheet swap behind every protocol-22 pose. A layer whose
   * staged twin does not exist (indexed art, recoloured `#ramp` canvases) holds its walk sheet's
   * standing frame, which is precisely how it already behaves when its `-idle` twin is missing:
   * the graceful-degradation contract is inherited, not invented here.
   */
  private poseLayers(entity: Entity, facing: Direction, suffix: string, column: number): void {
    for (const layer of entity.layers) {
      const walkSheet = layer.getData('sheet') as string | undefined;
      if (!walkSheet) {
        layer.setFrame(layerFrame(layer.texture, facing, column));
        continue;
      }
      const posed = walkSheet + suffix;
      if (this.textures.exists(posed)) {
        if (layer.texture.key !== posed) layer.setTexture(posed);
        if (suffix === DOWN_SUFFIX) {
          // The one sheet with no facing rows: a single row whose last frame is the body flat on
          // the floor, so the frame index is the column alone and `LPC_ROW` stays out of it. The
          // stride is the frame's own width, `layerFrame`'s argument exactly.
          const frameWidth = layer.texture.get(0)?.width || LPC_FRAME;
          const columns = Math.max(1, Math.floor(layer.texture.getSourceImage().width / frameWidth));
          layer.setFrame(columns - 1);
        } else {
          layer.setFrame(layerFrame(layer.texture, facing, column));
        }
      } else {
        if (layer.texture.key !== walkSheet) layer.setTexture(walkSheet);
        layer.setFrame(layerFrame(layer.texture, facing, WALK_STANDING_COLUMN));
      }
    }
  }

  /**
   * The images one art key is drawn from, stacked bottom-first and lifted onto its feet.
   *
   * An unknown key falls back to the plain human rather than drawing nothing: a mob the client has no
   * layer list for should look like *somebody* while the log says what it is, and an invisible entity is
   * the one failure that looks identical to the visibility gate working correctly.
   */
  /**
   * Puts one entity's health bar where its `healthFraction` says.
   *
   * Called from both halves of `upsertEntity` — creation and update — because the server sends a full
   * `EntityView` for either, and a bar refreshed on only one of them would be correct when a mob walked
   * into view and frozen for the rest of the fight.
   *
   * Hidden at full health, which is the one piece of judgement here: a castle of ninety-two untouched
   * servants would otherwise be ninety-two green bars, and the bar is far more useful as a signal that
   * *something has happened to this one* than as a permanent badge.
   */
  private refreshHealthBar(entity: Entity): void {
    const bar = entity.health;
    if (!bar) return;
    const fraction = Math.max(0, Math.min(1, entity.view.healthFraction ?? 1));
    if (fraction >= 1) {
      bar.setVisible(false);
      entity.healthTrough?.setVisible(false);
      return;
    }
    bar.setVisible(true);
    entity.healthTrough?.setVisible(true);
    bar.width = Math.max(1, HEALTH_BAR_WIDTH * fraction);
    bar.fillColor =
      fraction < HEALTH_LOW_BELOW ? HEALTH_LOW : fraction < HEALTH_HURT_BELOW ? HEALTH_HURT : HEALTH_FULL;
  }

  /**
   * The stack of sheets one body is drawn from.
   *
   * **A dressed character is drawn from what they are wearing**, which is Phase 15a and the roadmap's
   * completion test for this phase — the hardcoded outfit that used to live in `SPRITE_LAYERS` was a
   * placeholder with a comment saying exactly this would replace it.
   *
   * `SPRITE_LAYERS` survives for everything with no equipment list: mobs, whose look is their
   * template's own, and any character the server has not dressed. So the fallback is not dead code,
   * it is the answer for bodies that wear nothing.
   */
  /**
   * The texture key for what the wire says is worn in a slot, or nothing if it is not drawn.
   *
   * **The index first, the starter kit second.** `artgen` stages every sheet under its own art id, so
   * for indexed art the id the server sent *is* the texture key and there is no mapping at all — which
   * is the point: the table that used to sit here could not have held 319 entries, let alone 16,421
   * items' worth of choices, and every table like it in this project has eventually drifted.
   *
   * Anything unrecognised returns nothing and simply is not drawn. That is the correct answer for a
   * ring, for an item nobody has chosen art for, and for a sheet that failed to load — a body missing
   * a layer reads as unremarkable, where a magenta box reads as a crash.
   */
  /**
   * The layers one art id draws as, in draw order — **usually one, and for a quarter of the pack more.**
   *
   * This returned a single sheet until 2026-08-05, and that was the whole of three owner-reported
   * faults: a weapon that vanished when its wielder walked north, and a cloak that was nothing but a
   * collar. ULPC keeps the parts of a thing that sit *behind* the body on their own layers —
   * `weapon_sword_rapier` has the blade at z 140 and the same blade drawn behind its owner at z 9,
   * `cape_solid` has shoulders at z 85 and the hanging cloak at z 5 — and `artgen` was staging only
   * the first of them. It stages all of them now, and this hands the caller every one.
   *
   * The z on each layer is ULPC's own, so the caller sorts the whole body's stack by z and the behind
   * halves land under the body without a rule naming them.
   */
  private sheetsFor(id: string, fallbackZ: number): { sheet: string; z: number }[] {
    // **Parsed first, because a recoloured id must reach the index by its base half.** This lookup
    // used to take the id raw, and the miss was silent and total: `shield-heater-...#all_lpcr.black`
    // found no entry, no kit row, and returned nothing — so every ramped item on every body was
    // quietly dropped while its plain siblings drew fine. The owner found it the only way it could
    // be found (2026-08-07): *"it is also not loading the sprite for the shield I am wearing even
    // though an image is assigned to it."* `layerKeysFor` is A7e's one ramp-aware resolver — the
    // keys it returns carry the ramp, which is exactly what `ensureSheet` queues and what the
    // recolour registers, so the gate below and the canvas build cannot disagree about names.
    const art = LPC_ART_BY_ID.get(parseArtId(id).id);
    if (art) {
      // **Not yet loaded means not drawn, not drawn badly.** Handing Phaser a key it does not have
      // gets the missing-texture placeholder — a green box with a diagonal through it, sitting over
      // the character's head where their sword should be. Queue it and leave the layer out; the
      // redress when it lands is what puts the sword on, a frame or two later and unnoticeably.
      //
      // **All or nothing per art id**: half a cloak is worse than none, and the loader fetches every
      // layer in one go, so a partial stack would only ever be a frame wide anyway.
      const keys = layerKeysFor(id);
      if (keys.every((layer) => this.textures.exists(layer.key))) {
        return keys.map((layer) => ({ sheet: layer.key, z: layer.z }));
      }
      this.ensureSheet(id);
      return [];
    }
    const kit = KIT_ART[id];
    return kit ? [{ sheet: kit, z: fallbackZ }] : [];
  }

  /**
   * Notes that a sheet is wanted. **Queues only — the loader is kicked from `update`.**
   *
   * 319 sheets is not a preload: the starter kit's thirty go in up front because every character wears
   * some of them, but the indexed art is a long tail where a session might touch five, and paying 319
   * requests at boot to be ready for all of them is the wrong trade on any connection worse than
   * localhost.
   *
   * **Why it queues rather than loading here, and this cost an hour.** `LoaderPlugin.start()` puts the
   * scene back into its loading state, and the first bodies are built while `create` is still running —
   * so starting the loader from this call wedged the scene before it ever subscribed to anything. The
   * symptom was a client stuck on "connecting…" with the socket open, the server's whole join sequence
   * sent, and **not one error in the console**: nothing had thrown, the scene had simply stopped.
   * `update` cannot run until creation finishes, which makes it the one place a load is always safe.
   */
  private ensureSheet(key: string): void {
    // **An art id can be several sheets**, so this queues by *layer* rather than by id — otherwise a
    // cape asked for its shoulders and its cloak never arrived. An id with no index entry is the
    // starter kit, whose key is its own sheet.
    // A7e: `layerKeysFor` is the one function that knows an id may carry a `#ramp`. A plain id resolves
    // exactly as it did before, which is what keeps every unrecoloured item on the path it was on.
    for (const { key: sheet, sheet: plain } of layerKeysFor(key)) {
      if (!(this.textures.exists(sheet) || this.loadingSheets.has(sheet) || this.wantedSheets.has(sheet))) {
        this.wantedSheets.add(sheet);
      }
      // **The swing twins ride along with the walk.** `LPC_SHEET_GEOMETRY` is the existence table —
      // a `-slash`/`-thrust` listed there was staged by artgen — so the first swing of a session
      // plays against a texture that arrived with the weapon rather than one still in flight.
      // Plain keys only: a recoloured layer holds its walk frame mid-swing (the documented ramp
      // degradation), so queueing a twin it will never pose with would be a fetch for nobody.
      if (sheet !== plain) continue;
      for (const suffix of ['-slash', '-thrust'] as const) {
        const twin = plain + suffix;
        if (LPC_SHEET_GEOMETRY[twin] === undefined) continue;
        if (this.textures.exists(twin) || this.loadingSheets.has(twin) || this.wantedSheets.has(twin)) continue;
        this.wantedSheets.add(twin);
      }
    }
  }

  /**
   * Starts any queued sheet loads. Called from `update`, so never during scene creation.
   *
   * A texture that arrives *after* a body was built is a layer nobody added, so whoever is wearing it
   * is redressed on completion — cheap, because it only ever fires the first time a sheet is needed.
   */
  private pumpSheetQueue(): void {
    if (this.wantedSheets.size === 0 || this.load.isLoading()) return;
    for (const key of this.wantedSheets) {
      this.loadingSheets.add(key);
      const { sheet, ramp } = readLayerKey(key);
      if (ramp) {
        // **A7e: recoloured sheets do not go through the loader at all.** There is no URL for them —
        // the pixels are made here from a sheet that does exist — so they are built on a canvas and
        // registered as a texture directly. Everything downstream sees an ordinary texture key.
        void this.buildRecolouredSheet(key, sheet, ramp);
        continue;
      }
      // The frame size is the geometry table's or the body grid — a 192px oversize swing sliced at
      // 64 is eighteen columns of broken tiles, drawn without a single error anywhere.
      const frame = LPC_SHEET_GEOMETRY[key] ?? LPC_FRAME;
      this.load.spritesheet(key, `lpc/${key}.png`, { frameWidth: frame, frameHeight: frame });
      this.load.once(`filecomplete-spritesheet-${key}`, () => {
        this.loadingSheets.delete(key);
        this.redressWearers(key);
      });
    }
    this.wantedSheets.clear();
    // Only if something was actually queued: a pass that produced nothing but recolours must not start an
    // empty load, which would leave `isLoading` true and stall the next real one behind it.
    if (this.load.list.size > 0 || this.load.inflight.size > 0) this.load.start();
  }

  /**
   * Makes a recoloured texture and registers it under its own key — **A7e**.
   *
   * Falls back to the **uncoloured** sheet when the recolour cannot be made, rather than leaving the
   * layer absent: a hat in the wrong colour is a far smaller failure than a person with no hat, and it is
   * visible enough that somebody reports it.
   */
  private async buildRecolouredSheet(key: string, sheet: string, ramp: string): Promise<void> {
    try {
      const swaps = swapsForArt(artIdForSheet(sheet), ramp);
      const canvas = swaps.length > 0 ? await recolouredSheet(sheet, swaps) : null;
      if (canvas && !this.textures.exists(key)) {
        this.textures.addSpriteSheet(key, canvas as unknown as HTMLImageElement, {
          frameWidth: LPC_FRAME,
          frameHeight: LPC_FRAME,
        });
      } else if (!canvas && !this.textures.exists(key) && this.textures.exists(sheet)) {
        // The base is already loaded and the recolour came to nothing — the commonest reason being that
        // the chosen ramp *is* the base. Aliasing rather than copying keeps one set of pixels.
        this.textures.addSpriteSheet(key, this.textures.get(sheet).getSourceImage() as HTMLImageElement, {
          frameWidth: LPC_FRAME,
          frameHeight: LPC_FRAME,
        });
      }
    } catch (cause) {
      this.log.write('error', `Could not recolour ${sheet} as ${ramp}: ${String(cause)}`);
    } finally {
      this.loadingSheets.delete(key);
      this.redressWearers(key);
    }
  }

  /**
   * Redresses anybody whose body wants this texture key — art that arrived after they were built.
   *
   * Three ways a body can want a key, and the first was the only one this checked until 2026-08-07:
   * a worn art id that IS the key; a worn art id one of whose **layer keys** is the key — a
   * two-layer shield's behind-the-body copy completing must redress its wearer, or the body waits
   * on a texture that already landed and the shield never appears; and the **base stack** itself,
   * now that `characterLayers` skips-and-queues an unloaded body sheet instead of boxing it.
   */
  private redressWearers(key: string): void {
    for (const entity of this.entities.values()) {
      const worn = entity.view.wearing ? Object.values(entity.view.wearing) : [];
      const wearsIt = worn.some((id) => id === key || layerKeysFor(id).some((layer) => layer.key === key));
      const base = SPRITE_LAYERS[entity.view.sprite] ?? SPRITE_LAYERS['human'] ?? [];
      if (wearsIt || base.includes(key)) this.redressEntity(entity);
    }
  }

  /**
   * Rebuilds one body's layers in place, for art that arrived after it was drawn.
   *
   * **The layers, not the entity.** Destroying and recreating the whole thing would be three lines
   * shorter and would take the camera follow, the idle tween and the health bar with it — and for the
   * local player, dropping the follow mid-session is a camera that stops moving for no visible reason.
   * The container, its label and its bars are untouched; only the stack of images changes.
   */
  private redressEntity(entity: Entity): void {
    for (const layer of entity.layers) layer.destroy();
    const layers = this.characterLayers(entity.view.sprite, entity.view.facing, entity.view.wearing);
    entity.layers = layers;
    entity.container.add(layers);
    // Back under the label and the bars: `add` appends, and a body drawn over its own name is exactly
    // the sort of thing that looks like a z-order bug in the renderer rather than a load order here.
    for (const [index, layer] of layers.entries()) entity.container.moveTo(layer, index);
    // **And the footprint back to the very bottom, which that loop just took it off.** Owner report,
    // 2026-08-05: *"the ring around the feet has moved forward over the legs again"* — and the "again"
    // is the tell. The ring is built at index 0 and `moveTo(layer, 0…n)` walks the new stack into
    // those exact slots, pushing it up in front of the body every time a character's kit changes.
    // Which is precisely when it was noticed: putting on a shield and a cloak.
    //
    // Owner's rule for it, same day: *"the ring around the feet also needs to be moved to the bottom
    // layer so it is never over the legs."* So it is asserted here rather than left to fall out of
    // insertion order — a ring that is only behind the body until the next `wear` is not behind it.
    if (entity.footprint) entity.container.sendToBack(entity.footprint);
    this.faceEntity(entity, entity.view.facing);
  }

  private characterLayers(sprite: string, facing: Direction, wearing?: Readonly<Record<string, string>>): Phaser.GameObjects.Image[] {
    const dressed = wearing && Object.keys(wearing).length > 0;
    const base = SPRITE_LAYERS[sprite] ?? SPRITE_LAYERS['human'] ?? [];
    if (!SPRITE_LAYERS[sprite]) {
      this.log.write('error', `No artwork for "${sprite}"; drawing it as a plain human.`);
    }

    // The body always comes first and is never worn — it is what the clothes go on. Taking only the
    // first entry of the base stack rather than all of it is what drops the placeholder outfit.
    //
    // **Every worn slot, ordered by the pack's own `zPos`** — not a hand-kept list of slots. The list
    // this replaced was `['feet', 'legs', 'chest', 'head', 'offHand']`, and what it says by omission is
    // that a wielded weapon has never been drawable: `mainHand` was simply not in it, so a sword could
    // be equipped, sent on the wire and resolved to a real sheet, and still never reach the screen.
    // Sorting by the z the artist gave each layer is both the fix and the reason there is no list to
    // forget a slot from again.
    const stack = dressed
      ? [
          base[0] ?? 'body-human-male',
          // Indexed art brings its own z, one per layer. The starter kit predates the index, so it
          // keeps the painter's order 15a chose, expressed as z values on the same scale.
          ...Object.entries(wearing)
            .flatMap(([slot, id]) => this.sheetsFor(id, KIT_Z[slot] ?? 50))
            .sort((a, b) => a.z - b.z)
            .map((layer) => layer.sheet),
        ]
      : base;

    // **The base stack passes the same gate the worn stack always has.** `sheetsFor` refuses to
    // name a texture Phaser lacks; this map used to hand the body's own sheets over unguarded, and
    // in a session whose loader was interrupted mid-preload — a hot reload landing during a fight —
    // that painted the missing-texture placeholder at body size: the green box over a mob and the
    // red one over the owner's head that he photographed (2026-08-07). A body that queues and skips
    // the sheet is invisible for the frames until `redressWearers` rebuilds it, which is the same
    // one-frame gap every late-arriving garment already accepts.
    return stack
      .filter((sheet) => {
        if (this.textures.exists(sheet)) return true;
        this.ensureSheet(sheet);
        return false;
      })
      .map((sheet) => {
        const image = this.add.image(0, LPC_FOOT_OFFSET, sheet);
        // The walk sheet is the layer's identity; the idle one is derived from it when it stops.
        image.setData('sheet', sheet);
        image.setFrame(layerFrame(image.texture, facing));
        return image;
      });
  }

  /* ----------------------------------------------------------- input, loop */

  override update(time: number, delta: number): void {
    // The light HUD is a DOM panel and belongs to the character, not to the map — it has to keep
    // counting down while a zone is loading, so it runs before the grid is checked for. Affects are
    // the same kind of panel and count down against the same clock, so they run beside it.
    this.refreshLightHud(time);
    this.refreshAffectsHud(time);
    // Art wanted by bodies drawn this frame or last. Here rather than at the point of need because
    // starting the loader during scene creation stops the scene dead — see `ensureSheet`.
    this.pumpSheetQueue();

    const grid = this.grid;
    if (!grid) return;

    // How far the camera may scroll depends on the zoom (see `applyCameraBounds`), so the bounds
    // have to follow the tween rather than snapping to the ratio it is heading for. Without this,
    // zooming in from a view wider than the map pins the map to a corner until the tween lands.
    const camera = this.cameras.main;
    if (camera.zoomEffect.isRunning) {
      this.applyCameraBounds(camera.zoom, grid.width * TILE_SIZE, grid.height * TILE_SIZE);
    }

    // Shift turns the movement keys into single-room travel, so it must be read before steering:
    // gliding and stepping at once would walk the character back out of the room it just entered.
    // The step itself is sent from `takeExit` on the keydown event; this is only the suppression.
    const travelling = this.down('SHIFT');

    // Touching the movement keys takes the wheel back from a server-walked path. Once per grab, on
    // the press edge — see `manualControl`. `takeExit` does its own grab, because a vertical step
    // presses no key this list watches.
    const manual = MOVEMENT_KEYS.some((key) => this.down(key));
    if (manual && !this.manualControl) {
      this.net.send({ t: 'stop' });
      // The server confirms with an empty `path`; clearing here only makes the grab feel immediate.
      // It predicts a view, not state, which is the one thing a client is allowed to predict.
      this.drawPath([]);
      this.serverWalking = false;
      // Taking the wheel ends the drag as well as the route. A held button left following would
      // re-path a frame later and fight the key that just cancelled it, once every 120 ms, with the
      // character twitching between the two. Cancelling means cancelling; press again to follow.
      this.endDrag();
      // And the camera comes back to the character, for the same reason a click brings it back: a
      // player who is walking wants to see what they are walking into, not the corner they panned to.
      this.followSelf();
    }
    this.manualControl = manual;

    // After the grab above, so a keypress in the same frame as a drag wins.
    this.updateDrag(time);
    // Last, so a pan applied this frame is not immediately overwritten by a follow that is still
    // attached — `beginPan` detaches, but the grab above can re-attach in the very same frame.
    this.updatePan();

    const dx = travelling ? 0 : (this.down('D') || this.down('RIGHT') ? 1 : 0) - (this.down('A') || this.down('LEFT') ? 1 : 0);
    const dy = travelling ? 0 : (this.down('S') || this.down('DOWN') ? 1 : 0) - (this.down('W') || this.down('UP') ? 1 : 0);
    // A key held *across* a click is being ignored by the server for as long as the route lasts —
    // `stop` only fires on the press edge, so holding D and then clicking never sends one. Zeroing
    // the intent here rather than the raw keys keeps both halves honest at once: nothing is predicted
    // that the character is not doing, and the `steer 0,0` that goes out is read as a key release,
    // which deliberately does not cancel the route. When the route ends the held key differs from
    // what was last sent again, so it is re-stated and normal steering resumes by itself.
    // The joystick outranks both. It is a deliberate, held instruction, so it beats a stale route
    // (which it has already told the server to drop) and it beats the keyboard for the one frame
    // where a key goes down before `manualControl` has ended the drag.
    const intent = this.dragSteering
      ? { x: this.dragIntentX, y: this.dragIntentY }
      : this.serverWalking
        ? { x: 0, y: 0 }
        : normaliseIntent(dx, dy);

    if (this.resendIntent || intent.x !== this.lastIntentX || intent.y !== this.lastIntentY) {
      this.resendIntent = false;
      this.lastIntentX = intent.x;
      this.lastIntentY = intent.y;
      this.net.send({ t: 'steer', dx: intent.x, dy: intent.y });
    }

    const seconds = delta / 1000;

    // The steer still goes out above — the server is the authority on whether it moves anyone, and a
    // client that silently withheld input would be deciding a rule. What is withheld is the
    // *prediction*: a seated character the server will not move must not slide away here and be
    // snapped back every frame for as long as the key is held.
    const predicting = this.canMovePredicted && (intent.x !== 0 || intent.y !== 0);
    const followRate = ease(EASE_FOLLOW, seconds);

    for (const [id, entity] of this.entities) {
      // Where this body started the frame, so the walk cycle can be advanced by what it actually
      // covered. Taken before any of the three things below move it.
      const beforeX = entity.x;
      const beforeY = entity.y;
      if (id === this.selfId) {
        // Predict locally, then reconcile against the last authoritative position.
        if (predicting) {
          const next = stepMovement(grid, entity.x, entity.y, intent.x, intent.y, PLAYER_SPEED * seconds);
          entity.x = next.x;
          entity.y = next.y;
        }
        // **Position is predicted; facing is not, any more.**
        //
        // It used to be guessed from the movement keys, which was right while facing *meant* the way
        // you were walking. It no longer does: you turn to the door you open, the corpse you go
        // through, the person you look at, and — the case that made guessing untenable — the thing you
        // are fighting, so that backing away from something reads as backing away rather than as
        // turning your back on it. The client cannot know any of those; it does not know which corpse
        // `loot` picked or where the door is. So it stops deciding and takes the server's answer,
        // which arrives in the same `entityMoved` that carries everyone else's.
        //
        // The lag this costs is one tick, and facing tolerates it where position does not: a sprite a
        // tick late to turn is invisible, a sprite a tick late to move is the reason prediction exists.
        this.faceEntity(entity, entity.view.facing);
        const drift = Math.hypot(entity.serverX - entity.x, entity.serverY - entity.y);
        if (drift > SNAP_DISTANCE) {
          entity.x = entity.serverX;
          entity.y = entity.serverY;
        } else if (drift > 0.5) {
          // Two different jobs, so two different rates. While predicting, this is only nudging a
          // guess that is already nearly right, and easing gently keeps small corrections invisible.
          // While *not* predicting — click-to-move, or a key held across a click — the server is the
          // only source of motion and this is the sole thing moving the sprite at all, so it has to
          // follow as closely as a remote entity does rather than trailing a fifth of a room behind.
          const rate = predicting ? ease(EASE_PREDICTED, seconds) : followRate;
          entity.x += (entity.serverX - entity.x) * rate;
          entity.y += (entity.serverY - entity.y) * rate;
        }
      } else {
        // Remote entities are interpolated toward wherever the server last put them.
        entity.x += (entity.serverX - entity.x) * followRate;
        entity.y += (entity.serverY - entity.y) * followRate;
      }
      // **Measured after every source of motion has had its say** — prediction, snapping and easing
      // alike — so the cycle is driven by the ground the sprite actually covered this frame rather
      // than by what it was asked to do. A character being dragged back by a correction still walks.
      const stepped = Math.hypot(entity.x - beforeX, entity.y - beforeY);
      // **Two states, one threshold, and no gap between them.** The first version advanced above 0.01
      // and settled at exactly 0, which left everything in between doing neither — and *everything*
      // lands in between, because easing toward the server's position is asymptotic and never reaches
      // it. A stopped character kept a sub-pixel residue for ever and stood frozen mid-stride with one
      // foot in the air. Anything that is not a real step now settles.
      //
      // A snap is a teleport rather than a stride, so it settles too: past `SNAP_DISTANCE` the sprite
      // was relocated, and counting it would spin the legs for a journey nobody walked.
      const walking = stepped >= WALK_MOVING_EPSILON && stepped < SNAP_DISTANCE;
      if (walking) {
        entity.walked += stepped;
        this.faceEntity(entity, entity.view.facing);
      } else if (entity.walked !== 0) {
        entity.walked = 0;
        this.faceEntity(entity, entity.view.facing);
      }
      // **Protocol 22: time-driven poses advance every frame**, where the stride above only redraws
      // when ground was covered — a swing plays out standing perfectly still. Expiry is here rather
      // than in `faceEntity` because a pose function that deletes its own inputs mid-derivation is
      // how a frame gets drawn from a record that no longer exists; deleted first, the same call
      // rederives the pose from whatever remains true.
      if (entity.action || entity.view.casting) {
        if (entity.action && this.time.now - entity.action.startedAt >= ACTION_COLUMNS[entity.action.suffix] * ACTION_FRAME_MS) {
          delete entity.action;
        }
        this.faceEntity(entity, entity.view.facing);
      }
      entity.container.setPosition(Math.round(entity.x), Math.round(entity.y));
      // **The target marker, moved with the body it marks.** Owner's ask (2026-08-04): know which one
      // you are focused on, and know when that changed. Positioned here rather than parented to the
      // entity's container so it is never scaled or flipped by the sprite's own transforms — an arrow
      // that mirrors when the body turns west reads as a bug.
      //
      // Shown here as well as moved, because a target can *arrive*: follow a mob that fled and the
      // pointer at it outlives the room it left, so the frame the body reappears in is the frame the
      // chevron has to come back. `setTarget` cannot do that job — it fires on the `self` message,
      // which can land before the entity does.
      if (this.marker && this.markerId === entity.view.id) {
        this.marker.setPosition(Math.round(entity.x), Math.round(entity.y) - MARKER_HEIGHT).setVisible(true);
      }
    }

    // After the bodies have been moved, so a bubble lands on where its speaker is *this* frame rather
    // than where they were last one — the same ordering the chevron needs and for the same reason.
    this.advanceBubbles();

    // After the movement above, not before it: the lit set follows the *predicted* position, and
    // computing it from last frame's would leave the light trailing the character by a frame.
    this.refreshVisible();
    if (this.fogDirty) this.paintFog();

    // Creatures are drawn only where there is light to see them by. The server is the authority and
    // already stops sending entities that are not lit, so this is usually a no-op; it exists to cover
    // the frames between a tick and the message that describes it.
    //
    // Gated on `serverX/serverY`, not the eased render position. Both positions lag, independently:
    // the render one settles ~10px behind at 60fps while the local disc is computed from a
    // *predicted* observer that runs ahead. Testing the interpolated point made the two disagree by
    // up to a tile at the boundary — a fifth of the lit area at the starting two-tile radius — so a
    // creature walking along the edge of the torchlight blinked in and out of phase with the server's
    // own answer. The authoritative position is the one the server gated on, which leaves the
    // predicted observer as the only remaining difference instead of two.
    //
    // The local player is always drawn: you know where you are, and a bad or not-yet-reconciled
    // position must not make the character vanish.
    for (const [id, entity] of this.entities) {
      entity.container.setVisible(id === this.selfId || this.litAt(entity.serverX, entity.serverY));
    }
  }

  /**
   * Hands the keyboard to the command line, or takes it back.
   *
   * Held keys are released on the way in, deliberately. Focusing the prompt with a movement key down
   * would otherwise leave the character walking with no key the player could let go of to stop them:
   * `down` starts answering false, but the last steer the server was sent is still a push. Zeroing
   * the intent here sends the release the player can no longer send themselves.
   */
  /**
   * Hands the scene V4's overlay, so <kbd>Shift</kbd>+<kbd>M</kbd> and <kbd>Escape</kbd> can reach it.
   *
   * Injected rather than imported: the overlay is DOM built in `main.ts` beside the socket that feeds
   * it, and the scene needs exactly two verbs off it. Typed structurally for the same reason — this
   * file has no business knowing what else a `PlaceMap` can do.
   */
  setPlaceMap(map: { toggle(): void; hide(): void; readonly isOpen: boolean }): void {
    this.placeMap = map;
  }

  /** Hands the scene V5's caption. Structural, like {@link setPlaceMap} — one verb is all it needs. */
  setArrivalCard(card: { show(zoneName: string, level: number, levels: number): void }): void {
    this.arrival = card;
  }

  setTyping(typing: boolean): void {
    if (typing === this.typing) return;
    this.typing = typing;

    // **Gating our own reads is not enough.** Phaser calls `preventDefault()` on every key it was
    // asked to watch — W, A, S, D, the arrows, M, Q, E and Shift — in a document-level listener that
    // runs before the character can reach a focused `<input>`. So the game correctly does nothing
    // with the keystroke and the letter is *also* swallowed: typing "help" arrives as "hlp", "say"
    // as "y", "west" as "t". The capture is a property of the keyboard manager rather than of any
    // scene state, so it has to be switched off explicitly while the caret is in the prompt.
    //
    // Global rather than per-key: the captured set is whatever `addKeys` was given, and a second
    // list here would have to be kept in step with it forever — the next key anyone binds would
    // silently start eating itself out of typed words.
    const keyboard = this.input.keyboard;
    if (typing) keyboard?.disableGlobalCapture();
    else keyboard?.enableGlobalCapture();

    if (!typing) {
      // Whatever is physically held has not been sent since focus was lost. Say it again.
      this.resendIntent = true;
      return;
    }
    this.net.send({ t: 'steer', dx: 0, dy: 0 });
    this.lastIntentX = 0;
    this.lastIntentY = 0;
    this.endDrag();
  }

  private down(key: string): boolean {
    // One gate, read by every consumer of the keyboard, rather than a check at each of them.
    if (this.typing) return false;
    return this.keys[key]?.isDown ?? false;
  }

  /**
   * Takes an exit, on the press edge of a Shift-held travel key.
   *
   * **Driven by the keydown event, not by polling `JustDown` in `update`.** The polled version read
   * every travel key's edge unconditionally and only *then* asked whether Shift was down, so a chord
   * pressed as one gesture was a coin flip: press `Q` a frame before `Shift` and the edge was
   * consumed, discarded, and the step silently never happened. Measured at 60fps that is a 16 ms
   * window, which is well inside how precisely anyone presses two keys "together".
   *
   * Reading `event.shiftKey` fixes it at the root rather than widening the window. The modifier state
   * *at the moment of the press* is what the player meant, it arrives on the same event, and there is
   * no stored edge left over to fire later — which is the failure the old comment was guarding
   * against by throwing edges away. A tap shorter than one frame now also survives, where before both
   * the down and the up landed between two frames and `Key.onUp` cleared `_justDown` before anything
   * read it.
   *
   * `event.repeat` is still refused: a step teleports to a room centre and prints a full room
   * description, so honouring OS auto-repeat would fire ~30 rooms a second at the log and the server.
   */
  private takeExit(dir: Direction, needsShift: boolean, event: KeyboardEvent): void {
    if (this.typing || event.repeat) return;
    if (needsShift && !event.shiftKey) return;

    this.net.send({ t: 'move', dir });

    // Taking an exit is manual control, exactly as pressing a movement key is: whatever the server
    // was walking us along is no longer what we want. `update` cannot notice this for us any more —
    // it only sees the steering keys — so the grab happens here.
    if (this.serverWalking || this.dragPointer) {
      this.net.send({ t: 'stop' });
      this.drawPath([]);
      this.serverWalking = false;
      this.endDrag();
    }
  }

  /* ------------------------------------------------------------------ zoom */

  /** <kbd>M</kbd> toggles the whole-map view, returning to whichever wheel step it left. */
  private toggleZoom(): void {
    this.fitMode = !this.fitMode;
    this.frameCamera({ animate: true });
  }

  /**
   * One wheel notch is one rung of {@link ZOOM_STEPS}, never a fraction of one.
   *
   * The character stays centred at every rung. The wheel deliberately does **not** zoom toward the
   * pointer: anchoring the zoom on the cursor is the same thing as pushing the character off centre,
   * and being able to see where you are matters more here than being able to aim a zoom.
   */
  private onWheel(_pointer: Phaser.Input.Pointer, deltaY: number): void {
    if (deltaY === 0) return;
    // The first notch out of the overview returns to the ladder rather than moving along it,
    // otherwise M then wheel would skip a rung.
    if (this.fitMode) {
      this.fitMode = false;
      this.frameCamera({ animate: true });
      return;
    }
    const next = clamp(this.zoomStep + (deltaY > 0 ? 1 : -1), 0, ZOOM_STEPS.length - 1);
    if (next === this.zoomStep) return;
    this.zoomStep = next;
    this.frameCamera({ animate: true });
  }

  /**
   * Applies the current zoom step to the current grid.
   *
   * Also called after a Place change: the fit ratio and the centre are both properties of the map,
   * so a zoomed-out view would otherwise stay framed on the zone the player just left.
   */
  private frameCamera(options: FrameOptions = {}): void {
    const grid = this.grid;
    if (!grid) return;

    const camera = this.cameras.main;
    const step: ZoomStep = this.fitMode ? 'fit' : (ZOOM_STEPS[this.zoomStep] ?? 1);
    const animate = options.animate ?? false;
    const width = grid.width * TILE_SIZE;
    const height = grid.height * TILE_SIZE;

    // 'fit' is a property of the map rather than a ratio, so it is measured rather than listed.
    const zoom =
      step === 'fit'
        ? Math.max(0.08, Math.min(this.scale.width / width, this.scale.height / height) * 0.95)
        : step;

    this.applyCameraBounds(zoom, width, height);
    this.zoomCameraTo(zoom, animate);

    if (step === 'fit') {
      // The whole Place on screen, so there is nothing to follow and nowhere to zoom towards.
      this.stopFollowing();
      this.centreCameraOn(width / 2, height / 2, animate);
    } else {
      const self = this.selfId === undefined ? undefined : this.entities.get(this.selfId);
      if (self && !this.followTarget) {
        // Coming back from 'fit'. `startFollow` hard-sets the scroll, so glide across first and only
        // hand over once the camera has arrived — otherwise the view cuts while the zoom eases.
        if (animate) {
          camera.pan(self.x, self.y, ZOOM_MS, ZOOM_EASE, true, (_camera, progress) => {
            if (progress === 1) this.followSelf();
          });
        } else {
          this.followSelf();
        }
      }
    }

    this.applyLabelVisibility(step);
  }

  /**
   * Camera bounds for one zoom ratio.
   *
   * Phaser clamps the view to the camera bounds every frame, which is what keeps the far zoom steps
   * off the void beyond the map. But when the view is *larger* than the bounds it pins the map's
   * top-left corner to the view's top-left corner rather than centring it, so a map smaller than the
   * screen ends up wedged in one corner with void filling the rest — which is reachable now that the
   * ladder goes past the point where a small Place fits on screen. Growing the bounds to the size of
   * the view, centred on the map, makes that same clamp centre the map instead.
   */
  private applyCameraBounds(zoom: number, mapWidth: number, mapHeight: number): void {
    const camera = this.cameras.main;

    if (this.fitMode) {
      // The overview frames the map itself rather than the character, so the map is what the bounds
      // describe, centred in whatever space is left over.
      const width = Math.max(mapWidth, camera.width / zoom);
      const height = Math.max(mapHeight, camera.height / zoom);
      camera.setBounds((mapWidth - width) / 2, (mapHeight - height) / 2, width, height);
      return;
    }

    // Half a viewport of slack on every side, so the camera can centre on a character standing
    // anywhere — including the very corner of the map.
    //
    // Clamping to the map edge instead is what made a character near the top of the map slide off
    // centre as the view widened: the camera wanted to centre on them, the bounds would not let it
    // scroll past the edge, and the character drifted. From inside the game that reads as the map
    // lurching about rather than as the camera refusing to move.
    //
    // The cost is being able to see past the edge of the map, and it is no cost at all: never-seen
    // ground is painted full black by the fog and the camera clears to near-black, so off-map and
    // unexplored are indistinguishable.
    const marginX = camera.width / (2 * zoom);
    const marginY = camera.height / (2 * zoom);
    camera.setBounds(-marginX, -marginY, mapWidth + marginX * 2, mapHeight + marginY * 2);
  }

  private zoomCameraTo(zoom: number, animate: boolean): void {
    const camera = this.cameras.main;
    if (animate) {
      // `force` so a second notch overrides the notch still in flight rather than being dropped.
      camera.zoomTo(zoom, ZOOM_MS, ZOOM_EASE, true);
    } else {
      camera.zoomEffect.reset();
      camera.setZoom(zoom);
    }
  }

  private centreCameraOn(x: number, y: number, animate: boolean): void {
    const camera = this.cameras.main;
    if (animate) {
      camera.pan(x, y, ZOOM_MS, ZOOM_EASE, true);
    } else {
      camera.panEffect.reset();
      camera.centerOn(x, y);
    }
  }

  /**
   * Room names are 10px — unreadable at 0.25 and pure noise at 'fit'.
   *
   * Toggled rather than rebuilt: there are ~90 of them per Place and each one owns a text canvas.
   */
  private applyLabelVisibility(step: ZoomStep): void {
    // Every numeric rung from 0.5 up, which is 2, 1 and 0.5. `'fit'` is the only non-numeric step,
    // so this reads as "hidden at the two steps the comment names" rather than as a list that has to
    // be kept in sync with ZOOM_STEPS — an earlier list omitted 2 and hid the labels at the closest
    // zoom, where they are the most legible.
    const visible = typeof step === 'number' && step >= 0.5;
    for (const label of this.roomLabels) label.setVisible(visible);
  }

  private followSelf(): void {
    const self = this.selfId === undefined ? undefined : this.entities.get(this.selfId);
    if (!self) return;
    this.cameras.main.startFollow(self.container, true, 0.18, 0.18);
    this.followTarget = self.container;
  }

  private stopFollowing(): void {
    this.cameras.main.stopFollow();
    this.followTarget = undefined;
  }

  /* -------------------------------------------------------------- textures */



  /**
   * Ground-item sprites, generated rather than loaded.
   *
   * Same reasoning as the character placeholders: this is a mechanic landing before its art, and a
   * new art dependency would hold it up for a picture that LPC will replace anyway. What these have
   * to do is read as *a small bright thing lying on the floor* — smaller than a character, glowing,
   * and unmistakably not a person standing there.
   *
   * One per catalogue id, keyed by that id, so adding a sixth light source gives it a sprite without
   * touching this file. The colours are the only editorial part: warm and dim for the candle, hot
   * orange for the torch, cold and steady for the everburning one, and the beacon pale enough to
   * look like it is lighting the floor around it — which, for thirty seconds, it is.
   */

  /**
   * A portal on the wall it leaves through.
   *
   * Drawn rather than tiled, because a portal is precisely the exit the tilemap could *not* express:
   * `buildZoneTilemap` carves an opening only where the destination is the geometric neighbour, and a
   * portal is by definition where that reconciliation failed. So it is an object sitting on the wall
   * rather than a hole in it, which is also the honest picture — you are stepping somewhere the map
   * cannot draw a corridor to.
   *
   * Interactive on its own, not through the entity feed: a portal is a property of the *room*, which
   * the client already has in `RoomView.room.exits`, and inventing a server-side entity for a piece of
   * fixed geometry would put something in the interest-management path that never moves and never
   * changes. Clicking it offers `Enter portal`, which sends the ordinary `move` intent — the server has
   * always allowed a typed direction through a portal, so this makes the exit *visible* rather than
   * newly usable.
   */
  private makePortalMarker(origin: { tx: number; ty: number }, dir: Direction, roomId: RoomId): Phaser.GameObjects.Container {
    // On the wall, a little inside the room's floor, so it reads as being set *into* the wall rather
    // than standing on the ground in front of it.
    const mid = (ROOM_TILES / 2) * TILE_SIZE;
    const edge = ROOM_TILES * TILE_SIZE;
    const lip = TILE_SIZE * 0.4;
    const at =
      dir === 'north' ? { x: mid, y: lip }
      : dir === 'south' ? { x: mid, y: edge - lip }
      : dir === 'east' ? { x: edge - lip, y: mid }
      : dir === 'west' ? { x: lip, y: mid }
      // Up and down have no wall to sit on, so they go in a corner where they cannot be mistaken for
      // one of the four that do.
      : { x: edge - lip, y: lip };

    const container = this.add
      .container(origin.tx * TILE_SIZE + at.x, origin.ty * TILE_SIZE + at.y)
      .setDepth(2);
    // A ring rather than a filled shape, so whatever the wall is drawn as still reads through it, and
    // a violet nothing else in the palette uses — its whole job is to be noticed.
    const core = this.add.circle(0, 0, TILE_SIZE * 0.2, 0x5a3a8c, 0.55);
    const ring = this.add.circle(0, 0, TILE_SIZE * 0.34).setStrokeStyle(2, 0x9d6bd8, 0.95);
    container.add([core, ring]);

    // Remembered so `portalAt` can hit-test it. Cleared with the rest of `placeObjects` on a Place
    // change, because a portal belongs to a level's geometry and none of it survives leaving.
    this.portals.push({ dir, roomId, x: container.x, y: container.y });
    return container;
  }

  /**
   * The portal under a world point, if the player is standing in its room.
   *
   * Room-gated because the map draws the whole level: portals three rooms away are on screen, and
   * offering a verb the server would refuse is an invitation to a refusal.
   */
  private portalAt(x: number, y: number): { dir: Direction; roomId: RoomId; distance: number } | undefined {
    const reach = TILE_SIZE * 0.5;
    for (const portal of this.portals) {
      if (portal.roomId !== this.selfRoomId) continue;
      if (Math.abs(portal.x - x) <= reach && Math.abs(portal.y - y) <= reach) {
        // The same yardstick `entityAt` reports, because the press handler compares the two: a box
        // test decides *whether* the swirl was hit, the hypot decides who was hit *closer*.
        return { ...portal, distance: Math.hypot(portal.x - x, portal.y - y) };
      }
    }
    return undefined;
  }

  private makeItemTextures(): void {
    // Anything the server names that this build has never heard of. Deliberately drab: an unknown
    // pickup should look like a question, not like treasure.
    this.drawItemTexture(ITEM_TEXTURE_FALLBACK, 0x9a9384, 0x6a6558);

    const flames: Readonly<Record<string, readonly [flame: number, glow: number]>> = {
      candle: [0xffe6a8, 0xd8b874],
      torch: [0xffb257, 0xe07a2a],
      everburning_torch: [0xcfe8ff, 0x7fb0e0],
      lantern: [0xffd27a, 0xd8a13c],
      beacon_of_hope: [0xfff6e0, 0xffd27a],
    };
    for (const id of Object.keys(LIGHT_SOURCES)) {
      const [flame, glow] = flames[id] ?? [0xffb257, 0xe07a2a];
      this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}${id}`, flame, glow);
    }

    // Corpses. Two states, and the difference between them is the mechanic: a pile of bones is a corpse
    // nobody has been through, and a single bone is one that has been picked clean. That is readable from
    // across a room without walking over to look, which is what makes a corridor of corpses tell a story.
    this.drawCorpseTexture(`${ITEM_TEXTURE_PREFIX}corpse`, false);
    this.drawCorpseTexture(`${ITEM_TEXTURE_PREFIX}corpse_looted`, true);

    // Dropped objects, Phase 15b. Two shapes rather than one per item, keyed by slot on the server:
    // a weapon reads as a weapon at a glance and everything else as a bundle. Generated like the rest
    // because the LPC pack has no ground-object art at this size, and `itemTexture` resolves by key
    // with a fallback, so real art replaces these without touching anything else.
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_weapon`, 0xc8cbd0, 0x8a8f96);
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_bundle`, 0xb08a5c, 0x7d6240);
    // **One colour per kind of thing.** Owner's point (2026-08-03): *"not everyone reads every
    // description"* — so a thing on the floor has to say what it is at a glance, and two generic
    // blobs across a catalogue of 16,421 items made every floor look the same. Still generated
    // shapes rather than art (real per-item art is an LPC gap and Phase 16's), but a distinct colour
    // is enough to tell a flask from a coin from a sword without walking over to click it.
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_armour`, 0x8f98a8, 0x5d6472);
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_missile`, 0xa8926a, 0x6f5f44);
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_container`, 0x9a6f42, 0x6b4c2c);
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_flask`, 0x6fb3c8, 0x3f7a8c);
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_scroll`, 0xe0d6b0, 0xa89a70);
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_wand`, 0xb98ad8, 0x7d55a0);
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_coin`, 0xe8c25a, 0xa8862c);
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_key`, 0xc9b26b, 0x8d7a3e);
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_food`, 0xc07a5a, 0x8a5138);
    this.drawItemTexture(`${ITEM_TEXTURE_PREFIX}item_light`, 0xf0d68a, 0xb59a48);
  }

  /**
   * A corpse, drawn rather than loaded.
   *
   * `CLAUDE.md` requires one cohesive style and says that anything LPC lacks is **drawn to match** rather
   * than borrowed from elsewhere — and the vendored LPC set has no bones in it. So these are generated
   * the same way the ground-item sprites are, in the same muted bone palette, and `itemTexture` already
   * resolves by key with a fallback so real art replaces them without touching anything else.
   *
   * A bone is the classic shape: a shaft with two knobs at each end. Drawn from a small helper so the
   * pile and the single are unmistakably the same object at different counts, which is the whole signal.
   */
  /**
   * One 20x20 pickup: a dark haft, a flame, and two rings of halo around it.
   *
   * The halo is drawn into the texture rather than added as a light: the fog overlay is a single
   * blurred canvas painted from the lit set (see {@link paintFog}) and a real glow would have to
   * become part of that, which would make a torch on the floor brighten ground the character cannot
   * actually see. This one is decoration on the sprite and reveals nothing.
   */
  private drawItemTexture(key: string, flame: number, glow: number): void {
    const graphics = this.make.graphics({ x: 0, y: 0 }, false);
    graphics.fillStyle(glow, 0.16).fillCircle(10, 9, 9);
    graphics.fillStyle(glow, 0.3).fillCircle(10, 9, 6);
    graphics.fillStyle(0x2b2317, 1).fillRect(9, 10, 2, 8);
    graphics.fillStyle(glow, 1).fillCircle(10, 8, 4);
    graphics.fillStyle(flame, 1).fillCircle(10, 7, 2.6);
    graphics.fillStyle(shade(flame, 1.3), 1).fillCircle(10, 6, 1.2);
    graphics.generateTexture(key, 20, 20);
    graphics.destroy();
  }

  private drawCorpseTexture(key: string, looted: boolean): void {
    const graphics = this.make.graphics({ x: 0, y: 0 }, false);
    const SIZE = 24;
    const BONE = 0xeae4d2;
    const EDGE = 0x8b8471;
    const DARK = 0x4a463c;

    /**
     * One bone: a thin shaft with a knob at each end, outlined.
     *
     * Drawn outline-then-fill rather than as two offset copies — the first version stacked a shaded
     * bone under a light one, and at this size the offset simply fattened everything into a single
     * lump. An explicit darker stroke *under* a narrower light one keeps each bone legible where four
     * of them overlap, which is the whole difference between "a pile of bones" and "a blob".
     */
    const bone = (cx: number, cy: number, length: number, angle: number) => {
      const dx = Math.cos(angle) * (length / 2);
      const dy = Math.sin(angle) * (length / 2);
      // Knobs sit either side of the shaft's axis, which is what makes the silhouette read as a bone
      // rather than as a stick.
      const nx = Math.cos(angle + Math.PI / 2) * 1.15;
      const ny = Math.sin(angle + Math.PI / 2) * 1.15;
      for (const [colour, shaft, knob] of [[EDGE, 3.2, 2.0], [BONE, 1.7, 1.35]] as const) {
        graphics.fillStyle(colour, 1);
        for (const side of [1, -1]) {
          graphics.fillCircle(cx + dx * side + nx, cy + dy * side + ny, knob);
          graphics.fillCircle(cx + dx * side - nx, cy + dy * side - ny, knob);
        }
        graphics.lineStyle(shaft, colour, 1).lineBetween(cx - dx, cy - dy, cx + dx, cy + dy);
      }
    };

    // A soft shadow, so bones read as lying on the floor rather than floating above it.
    graphics.fillStyle(0x000000, 0.25).fillEllipse(12, 16, looted ? 12 : 19, looted ? 5 : 7);

    if (looted) {
      // Picked clean: one bone, off-centre, so it reads as a leftover rather than a tidy marker.
      bone(12, 13, 11, -0.26);
    } else {
      // A pile. Two long bones crossing low, two shorter ribs, and a skull sitting on top — drawn
      // bottom-up so the skull occludes the bones rather than the other way round.
      bone(11, 16, 17, 0.30);
      bone(13, 15, 16, -0.34);
      bone(6, 18, 8, -0.85);
      bone(18, 18, 7, 0.80);

      // The skull: cranium, sockets, a hint of jaw. Small enough to sit on the pile without becoming
      // the whole sprite.
      graphics.fillStyle(EDGE, 1).fillCircle(12, 8, 5.4);
      graphics.fillStyle(BONE, 1).fillCircle(12, 7.7, 4.6);
      graphics.fillStyle(EDGE, 1).fillRect(9.2, 10.4, 5.6, 3.0);
      graphics.fillStyle(BONE, 1).fillRect(9.7, 10.4, 4.6, 2.3);
      graphics.fillStyle(DARK, 1).fillCircle(10.2, 7.6, 1.35).fillCircle(13.8, 7.6, 1.35);
      graphics.fillStyle(DARK, 0.8).fillRect(11.4, 9.4, 1.2, 1.5);
      // Two teeth, which is what finally makes it read as a skull at this size rather than as a pebble.
      graphics.fillStyle(DARK, 0.55).fillRect(10.8, 11.2, 0.8, 1.6).fillRect(12.6, 11.2, 0.8, 1.6);
    }

    graphics.generateTexture(key, SIZE, SIZE);
    graphics.destroy();
  }

  /**
   * The texture for a ground item's sprite key.
   *
   * Resolved only against the generated item set, never against every texture this scene owns: the
   * terrain sheets are loaded under bare names like `rock` and `water`, so a server that sent one of
   * those as a sprite key would otherwise stamp a whole 32px terrain tile on the floor and it would
   * look like a rendering fault rather than a bad key. When real art arrives this becomes an atlas
   * lookup and the fallback stays exactly where it is.
   */
  private itemTexture(sprite: string): string {
    const key = `${ITEM_TEXTURE_PREFIX}${sprite}`;
    return this.textures.exists(key) ? key : ITEM_TEXTURE_FALLBACK;
  }

  /**
   * The image or images a thing on the floor is drawn as — A7d.
   *
   * Two cases, and the placeholder is **demoted rather than retired**. An item nobody has chosen art
   * for keeps its category glyph, which still says *this is a weapon* — better than a blank, and the
   * nine of them cover all 16,421 catalogue entries. An item with authored art draws that art
   * instead, from the sheet the picker chose.
   *
   * **The frame is column 0 of row 2** — LPC's south-facing standing pose, the same crop the admin
   * picker's thumbnails use, and for the same reason: it is the one frame every staged sheet has and
   * the one that reads as a picture of the thing rather than a pose. Deliberately *not* the pack's
   * `preview_row`/`preview_column`, which the roadmap expected to use — only **24 of 657**
   * definitions carry those fields, so building on them would have dressed 3.6% of the pack and left
   * the rest looking broken by comparison.
   *
   * Layered, because art can be several sheets since the multi-layer fix — a cloak lying on the floor
   * is its hanging half *and* its shoulders, and drawing one of the two is how it went wrong on a
   * body. Not yet loaded means the placeholder for a frame or two, then a redress; never `__MISSING`.
   */
  private itemLayers(sprite: string): Phaser.GameObjects.Image[] {
    const art = LPC_ART_BY_ID.get(sprite);
    if (!art) return [this.add.image(0, 0, this.itemTexture(sprite))];
    if (!art.layers.every((layer) => this.textures.exists(layer.sheet))) {
      this.ensureSheet(sprite);
      return [this.add.image(0, 0, this.itemTexture(sprite))];
    }

    const images = art.layers.map((layer) => {
      const image = this.add.image(0, 0, layer.sheet);
      image.setData('sheet', layer.sheet);
      image.setFrame(layerFrame(image.texture, 'south'));
      return image;
    });

    // **Cropped to what is actually drawn** — owner's report, 2026-08-05, on a cloak that looked like
    // it was sitting at the bottom of its own picture.
    //
    // An LPC frame is 64x64 and shaped for a *whole person*, so a garment only ever fills part of it:
    // a cloak hangs from the shoulders down and measures **nothing at all in the top half** of every
    // facing. Centred as an icon, that is an object sitting low under a void, which reads as sunken
    // rather than as a thing lying on the ground.
    //
    // The union across layers, not each separately — a cloak is two sheets and cropping them
    // independently would slide its halves apart.
    const bounds = this.artBounds(art.layers.map((layer) => layer.sheet));
    if (bounds) {
      for (const image of images) {
        image.setCrop(bounds.x, bounds.y, bounds.w, bounds.h);
        // `setCrop` does not move the object: the origin still refers to the whole frame, so the
        // visible part stays where it was inside it. Shifting by the crop's offset from the frame
        // centre is what actually centres the *content*.
        image.setPosition(LPC_FRAME / 2 - (bounds.x + bounds.w / 2), LPC_FRAME / 2 - (bounds.y + bounds.h / 2));
      }
    }
    return images;
  }

  /** Measured alpha bounds per sheet-set, so the scan happens once and not per dropped item. */
  private readonly boundsCache = new Map<string, { x: number; y: number; w: number; h: number } | undefined>();

  /**
   * The tightest box containing anything opaque, across a set of sheets' south standing frames.
   *
   * **Measured from the texture the client already has**, which is the whole reason this is cheap: it
   * needs no PNG decoder in `artgen` and no new field on the wire. One canvas readback per sheet-set,
   * cached for the session — a floor with twenty daggers on it scans once.
   *
   * `undefined` for a frame with nothing in it, or if the readback fails, and the caller then draws
   * uncropped: an icon that is slightly low is much better than an icon that is not there.
   */
  private artBounds(sheets: readonly string[]): { x: number; y: number; w: number; h: number } | undefined {
    const key = sheets.join('|');
    const cached = this.boundsCache.get(key);
    if (cached !== undefined || this.boundsCache.has(key)) return cached;

    let minX = LPC_FRAME;
    let minY = LPC_FRAME;
    let maxX = -1;
    let maxY = -1;
    try {
      const scratch = document.createElement('canvas');
      scratch.width = LPC_FRAME;
      scratch.height = LPC_FRAME;
      const ctx = scratch.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2d context');
      for (const sheet of sheets) {
        const source = this.textures.get(sheet).getSourceImage() as CanvasImageSource;
        ctx.clearRect(0, 0, LPC_FRAME, LPC_FRAME);
        // Column 0 of row 2 — the same south-facing standing frame the icon draws.
        ctx.drawImage(source, 0, LPC_ROW.south * LPC_FRAME, LPC_FRAME, LPC_FRAME, 0, 0, LPC_FRAME, LPC_FRAME);
        const data = ctx.getImageData(0, 0, LPC_FRAME, LPC_FRAME).data;
        for (let y = 0; y < LPC_FRAME; y++) {
          for (let x = 0; x < LPC_FRAME; x++) {
            // The same alpha floor the sheet measurements used, so a stray anti-aliased pixel does
            // not stretch the box back out to the whole frame.
            if (data[(y * LPC_FRAME + x) * 4 + 3]! <= 8) continue;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
    } catch {
      this.boundsCache.set(key, undefined);
      return undefined;
    }

    const found = maxX >= minX && maxY >= minY
      ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
      : undefined;
    this.boundsCache.set(key, found);
    return found;
  }
}

/* ---------------------------------------------------------------- helpers */

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Turns a per-frame-at-60fps easing factor into one for the frame that actually happened.
 *
 * The raw factors are "close this fraction of the remaining gap each frame", which silently makes
 * the correction *rate* a property of the display. The server advances a walker 15px every 100ms, so
 * an unpredicted local player settles at the gap where the easing exactly keeps up: 21px at 60fps
 * with a 0.12 factor, but 42px at 30fps — past `SNAP_DISTANCE`, so instead of easing it hard-snapped
 * on essentially every frame. Compounding over the real frame time fixes the time constant instead
 * of the per-frame step, and the behaviour stops depending on the monitor.
 */
function ease(rate: number, seconds: number): number {
  return 1 - Math.pow(1 - rate, seconds * 60);
}

/** Pixel centre of a tile. Routes are drawn through tile centres, not corners. */
function tileCentre(tile: number): number {
  return (tile + 0.5) * TILE_SIZE;
}

/**
 * The frame index for a facing and a point in the walk cycle, on whatever sheet this layer uses.
 *
 * Frames run left to right then down, so row R column C is `R * columns + C` — and the columns are read
 * from the texture rather than assumed, because sheets in the pack are not all the same width.
 * Hardcoding a stride would silently draw the west-facing body under the north-facing shirt.
 *
 * The column is **clamped to what this texture actually has**, so a layer still staged from a 2-column
 * `idle.png` degrades to standing rather than indexing off the end of its sheet into another row's
 * frames — which is the failure that would look like a character whose hat faces backwards.
 */
/**
 * Where in the walk cycle a body currently is.
 *
 * The cycle runs 0 through 7 and *includes* the rest pose, because column 0 is a genuine frame of an
 * LPC walk — the moment both feet are down — rather than a separate idle. See {@link WALK_COLUMNS}
 * for why the ninth column is not in it.
 */
function walkColumn(entity: Entity): number {
  if (entity.walked === 0) return WALK_STANDING_COLUMN;
  return Math.floor(entity.walked / WALK_PIXELS_PER_FRAME) % WALK_COLUMNS;
}

/** Whether two wearing maps describe the same outfit — the redraw-on-update gate in `upsertEntity`. */
function sameWearing(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const slots = Object.keys(left);
  if (slots.length !== Object.keys(right).length) return false;
  return slots.every((slot) => left[slot] === right[slot]);
}

function layerFrame(texture: Phaser.Textures.Texture, facing: Direction, column = WALK_STANDING_COLUMN): number {
  const source = texture.getSourceImage();
  // The stride is the texture's **own** frame width, not the 64px body grid: a 192px oversize swing
  // sheet is six columns, and dividing its 1152px by 64 would walk the index eighteen frames per
  // row — deep into the wrong facing. Frame 0 knows what the loader sliced; asking it keeps this
  // correct for every cell size the pack ships without a second geometry lookup here.
  const frameWidth = texture.get(0)?.width || LPC_FRAME;
  const columns = Math.max(1, Math.floor(source.width / frameWidth));
  return LPC_ROW[facing] * columns + Math.min(column, columns - 1);
}

// `facingOf` used to live here — the client's own copy of "which way am I looking", derived from the
// movement keys. It is gone, and its absence is the point: facing is a game rule now (you turn to what
// you are dealing with, and in a fight to your opponent), and a rule is the server's. The client draws
// the row the server names. Deleting it is also the check that nothing else was quietly guessing.

/**
 * Positional hash for tile variation.
 *
 * Deliberately a pure function of the coordinate rather than a running RNG: the scatter must be
 * identical for every player and stable across reloads, and it must not depend on the order tiles
 * happen to be drawn in.
 */
function hashTile(tx: number, ty: number): number {
  let h = (Math.imul(tx, 73856093) ^ Math.imul(ty, 19349663)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

function shade(colour: number, factor: number): number {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((colour >> 16) & 0xff) * factor);
  const g = clamp(((colour >> 8) & 0xff) * factor);
  const b = clamp((colour & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/**
 * The HUD's Place line.
 *
 * The level is only shown for zones that actually have more than one — most do not, and "level 0"
 * on every screen is noise. Where it does appear it is the only clue that a staircase changed the
 * map, since the zone name alone is unchanged.
 */
function zoneLabel(zone: Zone, level: number): string {
  const levels = new Set(zone.rooms.map((room) => room.pos.z));
  return levels.size > 1 ? `${zone.name} · level ${level}` : zone.name;
}

/**
 * How long a carried light has left, at three resolutions.
 *
 * The resolution *is* the warning. Minutes while there is no decision to make, whole seconds once
 * the last minute starts, and tenths for the final few — a readout that suddenly starts moving ten
 * times faster is read before it is read, which is the point: the design doc asks for the burn-out
 * to announce itself rather than to be discovered as a radius that quietly shrank.
 *
 * `padStart` rather than a format specifier — `console.log` has none, and neither does this.
 */
function formatRemaining(ms: number): string {
  if (ms <= LIGHT_URGENT_MS) return `${(ms / 1000).toFixed(1)}s`;

  // Rounded once and *then* split, rather than choosing the format from the raw milliseconds. The
  // other way round, anything from 59.001s up reads as "60s" for a whole second — so the countdown
  // goes 1:01, 1:00, 60s, 59s and appears to stall at the minute mark.
  const seconds = Math.ceil(ms / 1000);
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return `${seconds}s`;
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}
