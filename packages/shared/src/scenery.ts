/**
 * Scenery — the things that stand in a room.
 *
 * V8d, and the owner's ask on first walking the open square: *"we will have to think about adding
 * some scenery at some point, also a fountain or pothole or something like that, just for
 * atmosphere."* The Great Crossing's prose has promised a fountain and a plinth since Phase 23, and
 * until now the promise was only text.
 *
 * **A prop is a thing in the way.** That is the whole definition, and it is what separates scenery
 * from the decoration the client has drawn since V8a. Tile variants — the grass tufts, the cobble
 * mix, the scattered rock — are chosen by a hash of the coordinate and change nothing about the
 * room; they are paint, and paint can live in the client because it can never desync. A prop
 * occupies ground, so it is a rule, so it is here in `shared` where the server and every client
 * read one table and stamp the same tiles. Anything that would *not* be in the way does not belong
 * in this file.
 *
 * That rule is why there is no `solid` field. Every prop is solid; a non-solid prop is paint that
 * wandered into the wrong module.
 *
 * **Footprint and artwork are different rectangles**, and conflating them is the trap. `width` and
 * `depth` are the ground the prop stands on — the tiles that stop being walkable. `height` is how
 * tall the picture is, and it may exceed `depth`: a statue occupies one tile of floor and is drawn
 * two tiles tall, the upper one overhanging the ground *behind* it, which is how a three-quarter
 * view reads as having height at all. The art's bottom edge always sits on the footprint's bottom
 * edge, so `height - depth` is the overhang.
 *
 * This module is **deliberately import-free**: it is the catalogue and nothing else. Turning a prop
 * into tiles is geometry and lives in `tilemap.ts` ({@link tilemap.sceneryTile},
 * {@link tilemap.scenerySiting}), which imports this — one direction, no cycle, and the reason the
 * stamping code is not here beside the table it reads.
 *
 * @see `DESIGN-open-world.md` §V8d.
 */

/** Every prop the world knows how to stand up. The client keeps one image per name. */
export const SCENERY_KINDS = [
  'fountain', 'plinth', 'well', 'statue', 'cart', 'haystack',
  // Scatter — never authored, placed by `scatterFor`. See its note for why they are solid.
  'stump', 'log', 'bush', 'toadstools',
] as const;

export type SceneryKind = (typeof SCENERY_KINDS)[number];

export interface SceneryProp {
  /** Footprint east-west, in tiles. Also the width of one frame of the artwork. */
  readonly width: number;
  /** Footprint north-south, in tiles: the ground it stands on, and the ground you cannot cross. */
  readonly depth: number;
  /**
   * Artwork height in tiles, never less than {@link depth}. The picture's bottom edge sits on the
   * footprint's bottom edge, so any excess overhangs the ground behind the prop.
   */
  readonly height: number;
  /** Animation frames, laid left to right in the image file. 1 for a still prop. */
  readonly frames: number;
  /** Milliseconds a frame is held. Ignored when {@link frames} is 1. */
  readonly frameMs: number;
  /**
   * Stops sight as well as movement.
   *
   * Almost nothing here does. You see over a fountain's rim, a well's, a cart's sideboard and a
   * statue's shoulder — they are waist-high or narrow, and a plaza that went dark behind its own
   * furniture would be a worse lie than one you can see across. The hay bale is the exception:
   * three tiles of stacked straw is taller than the person looking at it.
   */
  readonly opaque: boolean;
  /**
   * What you can call it. Lowercase, whole words, matched the way `find_ex_description` matches.
   *
   * A prop that is drawn and cannot be named is furniture in a shop window: you can see a fountain
   * from across the plaza and the game denies one exists the moment you type its name. These are
   * the **default** words for the kind — a room that authors an `extras` block for its own fountain
   * outranks them, because bespoke prose beats a catalogue line every time.
   */
  readonly keywords: readonly string[];
  /** What looking at one says, when the room has not written something better. */
  readonly look: string;
  /**
   * That this prop is a room's noticeboard **made visible** — the owner's ask, 2026-08-10:
   * *"maybe the plinth can be the noticeboard that should be read."*
   *
   * It had been two authored facts about one object: `Room.board` has carried the posts since Phase
   * 23 and V8d stood a plinth in the same room because the prose promised one, with nothing joining
   * them. This is the join, and it keeps the Diku split that makes the pair read properly — **look
   * at it, read what is on it.** `look plinth` describes the granite and the four iron bolts;
   * `read plinth` is the notices bolted to it, the same listing `read board` gives.
   *
   * Only meaningful in a room that actually has a `board`. A plinth standing anywhere else is a
   * plinth.
   */
  readonly bearsBoard?: true;
}

/**
 * The catalogue.
 *
 * Sizes are measured from the artwork rather than chosen: each prop is a rectangular crop at the
 * source atlas's own 32px grid, so `width` and `height` are that crop in tiles and cannot drift
 * from the picture. `depth` is the only judgement — how much of the picture is standing on the
 * floor rather than rising above it.
 */
export const SCENERY: Readonly<Record<SceneryKind, SceneryProp>> = {
  /** Three frames of a jet rising and falling. The one prop that moves, and the one that was asked for. */
  fountain: {
    width: 2, depth: 2, height: 2, frames: 3, frameMs: 220, opaque: false,
    keywords: ['fountain', 'water', 'basin', 'jet'],
    look: 'A stone fountain, worn round at the lip by hands and weather. Water climbs a short column at its centre and falls back muttering into the basin.',
  },
  /** A stepped granite dais with a board bolted to it — the Great Crossing's noticeboard, made visible. */
  plinth: {
    width: 3, depth: 3, height: 3, frames: 1, frameMs: 0, opaque: false,
    keywords: ['plinth', 'noticeboard', 'notices', 'board', 'granite'],
    look: 'A stepped block of grey granite, waist high and squared off. A broad board is bolted flat to its face, layered with notices under the weather.',
    bearsBoard: true,
  },
  well: {
    width: 2, depth: 2, height: 2, frames: 1, frameMs: 0, opaque: false,
    keywords: ['well', 'wellhead', 'shaft'],
    look: 'A round wellhead of mortared stone, the courses inside slick and dark. Whatever is down there is a long way down.',
  },
  /** One tile of floor, two tiles of marble: the overhang case the `height` field exists for. */
  statue: {
    width: 1, depth: 1, height: 2, frames: 1, frameMs: 0, opaque: false,
    keywords: ['statue', 'figure', 'marble'],
    look: 'A marble figure on a low base, the face weathered past recognising. Whoever it was, the city has stopped explaining.',
  },
  cart: {
    width: 2, depth: 2, height: 2, frames: 1, frameMs: 0, opaque: false,
    keywords: ['cart', 'handcart', 'barrow'],
    look: 'A wooden handcart tipped onto its shafts, one wheel worn to the felloe. Empty, and not recently.',
  },
  haystack: {
    width: 2, depth: 2, height: 3, frames: 1, frameMs: 0, opaque: true,
    keywords: ['haystack', 'hay', 'bale', 'straw'],
    look: 'A round bale of straw, taller than you are and packed hard. Something could be lost in that and never found.',
  },
  stump: {
    width: 1, depth: 1, height: 1, frames: 1, frameMs: 0, opaque: false,
    keywords: ['stump', 'tree'],
    look: 'The sawn-off stump of a tree, roots still gripping. Somebody wanted it gone and did not want it far.',
  },
  log: {
    width: 3, depth: 2, height: 2, frames: 1, frameMs: 0, opaque: false,
    keywords: ['log', 'trunk', 'deadfall'],
    look: 'A fallen trunk gone soft with rot, lying where the wind put it.',
  },
  bush: {
    width: 2, depth: 2, height: 2, frames: 1, frameMs: 0, opaque: false,
    keywords: ['bush', 'shrub', 'scrub'],
    look: 'A dense low bush, too thick to push through and too short to hide behind.',
  },
  toadstools: {
    width: 1, depth: 1, height: 1, frames: 1, frameMs: 0, opaque: false,
    keywords: ['toadstools', 'toadstool', 'mushrooms', 'fungus'],
    look: 'A crowd of pale toadstools, shouldering up through the wet.',
  },
} as const;

/** A prop standing in a room, at a tile offset inside that room's own block. */
export interface RoomScenery {
  readonly kind: SceneryKind;
  /** Room-relative tile of the footprint's north-west corner. */
  readonly tx: number;
  /** Room-relative tile of the footprint's north-west corner. */
  readonly ty: number;
  /**
   * The vnum of something lost in it, put there hidden — the owner's ask, 2026-08-10: *"maybe the
   * haystack can be searched with a chance of finding a needle."*
   *
   * On the **prop** rather than in a reset's object list, and the difference is the whole point of
   * the field. A reset `O` command would put a needle in the same *room*, which is a different
   * sentence: it would be lying on the floor of a room that happens to contain a haystack. Saying
   * it here is saying the bale is what it is lost in, which is what makes `search haystack` mean
   * something more than `search`.
   *
   * The item is dropped once at boot, `hidden`, and does not decay — see `seedConcealed` in the
   * server. Finding it is permanent for that uptime, exactly as `do_search` clearing `ITEM_SECRET`
   * is permanent for that reset.
   */
  readonly conceals?: number;
}

export function isSceneryKind(value: unknown): value is SceneryKind {
  return typeof value === 'string' && (SCENERY_KINDS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Scatter                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What grows where. A sector with no row gets nothing, which is most of them.
 *
 * Deliberately short. Interiors, cities and roads are places people keep clear, and a stump in the
 * middle of the Spine would say the wrong thing about a city that sweeps its streets. Mountain and
 * cave get nothing either: the blocker lines V8b stamps on their borders are already rock, and
 * loose scenery on top of that reads as clutter rather than as terrain.
 */
const SCATTER_BY_SECTOR: Readonly<Record<string, readonly SceneryKind[]>> = {
  forest: ['stump', 'bush', 'bush', 'toadstools'],
  field: ['bush', 'stump'],
  hills: ['bush', 'stump'],
  swamp: ['stump', 'toadstools', 'toadstools', 'bush'],
};

/**
 * The four blocks a scattered prop may stand in.
 *
 * **This is the safety property, and the first version of it was wrong in play.** The owner walked
 * into a bog room from the north and could not move: *"I was stuck behind the log in the top left
 * corner."* The rule then was only that the centre row and column stayed clear, which guarantees a
 * plus-shaped path across the room and is not enough, for two reasons the room itself showed.
 *
 * **Arrival is not the centre.** {@link tilemap.arrivalTile} spreads an entering body *laterally*
 * across tiles 1 to 7 of the edge it came through — so walking in from the north can put you on
 * tile 1, and a 3-wide log occupying tiles 1 to 3 is a body standing inside a prop. Nothing about
 * the centre cross prevents that.
 *
 * **And a one-tile gap is not a corridor.** A prop one tile in from the wall leaves a 32px channel
 * for a 20px collision box ({@link tilemap.PLAYER_RADIUS}): passable on paper, a wedge in practice,
 * and worst exactly where you have to turn a corner.
 *
 * So the clear set is now everything the player might arrive on or need to walk down — **the ring
 * one tile in from each wall, and the centre cross** — which leaves four 2x2 blocks. A prop must fit
 * inside one. That is why {@link SCATTER_BY_SECTOR} holds nothing wider than two tiles, and why the
 * log stays in the catalogue for *authoring* (where a human can see the room) but is not scattered.
 *
 * **Exported for M2.** `roomScene.ts` places its landmark slot in one of these same four blocks, and
 * it has to be *these* four rather than a second list that agrees today: the law they encode — the
 * arrival ring and the centre cross stay walkable — is a safety property, and the whole-world
 * invariant sweep checks it against this constant. Two lists would let a landmark drift into the
 * doorway a player arrives through and the test would still pass.
 */
export const SCATTER_BLOCKS: readonly { readonly tx: number; readonly ty: number }[] = [
  { tx: 2, ty: 2 },
  { tx: 5, ty: 2 },
  { tx: 2, ty: 5 },
  { tx: 5, ty: 5 },
];

/** Each block is 2x2 — the space left once the arrival ring and the centre cross are reserved. */
export const SCATTER_BLOCK_TILES = 2;

/** A hash of the room id and a salt. Same shape as the client's tile scatter, and for the reason. */
function hashRoom(roomId: number, salt: number): number {
  let h = (Math.imul(roomId, 73856093) ^ Math.imul(salt, 19349663)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * What the wilderness grows in a room, derived rather than authored.
 *
 * 851 rooms went seamless in V8c and every one of them reads as flat lawn: the room graph gave them
 * borders and the sector gave them a colour, and nothing gave them anything to stand behind. This
 * fills them, and it has to be **derived** because 851 rooms is past the point where authoring is
 * honest work.
 *
 * **Solid, like every other prop**, and that is the whole reason this lives in `shared` and not in
 * the client's variant tables. A bush you walk through is paint pretending to be terrain; a bush you
 * walk around is why the forest feels like a forest. The cost is that the server and every client
 * must agree exactly, which a pure function of the room id gives for free — no RNG stream, no order
 * dependence, no message on the wire.
 *
 * **A room that was authored keeps what it was given.** Scatter never joins authored scenery: an
 * author who dressed a room owns it, and mixing the two would mean hand-placed props competing for
 * tiles with generated ones — which is a collision rule nobody wants to debug.
 *
 * **A staircase is the one obstacle this function cannot dodge from here.** `tilemap.stairPlacement`
 * stamps flights inside the same room block, at offsets derived from the room id *and the vertical
 * exits* — and the exits are deliberately not among these inputs. The join is `tilemap.sceneryOf`,
 * which drops any prop returned here whose footprint would share a tile with a flight: a clash
 * thins the room, exactly as the quadrant dedupe below does, and this module stays the catalogue —
 * import-free, and blind to geometry it does not own.
 */
export function scatterFor(
  roomId: number,
  sector: string,
  authored: readonly RoomScenery[] | undefined,
): readonly RoomScenery[] {
  if (authored?.length) return authored;
  const palette = SCATTER_BY_SECTOR[sector];
  if (!palette) return [];

  // Nought to three. **Measured rather than guessed**: at one prop per room the Stag Forest still
  // read as lawn — an 81-tile room with a single bush in it is a lawn with a bush on it — and the
  // rooms are flush in a seamless zone, so what the eye takes in at once is several of them. A
  // quarter staying empty is what stops the result reading as a regular pattern; the quadrant
  // dedupe below thins the rest, so the average lands near two.
  const count = [0, 2, 3, 4][hashRoom(roomId, 0) % 4] ?? 0;
  if (count === 0) return [];

  const out: RoomScenery[] = [];
  const usedBlocks = new Set<number>();
  for (let i = 0; i < count; i++) {
    const block = hashRoom(roomId, i * 2 + 1) % SCATTER_BLOCKS.length;
    if (usedBlocks.has(block)) continue; // one prop per block; a clash simply thins the room
    usedBlocks.add(block);

    const kind = palette[hashRoom(roomId, i * 2 + 2) % palette.length];
    if (!kind) continue;
    const spec = SCENERY[kind];
    // A palette entry too big for a block would silently overflow into the arrival ring, which is
    // the exact bug this rule exists to stop. Skipped rather than clamped: a prop that quietly
    // moved somewhere legal would hide the authoring mistake.
    if (spec.width > SCATTER_BLOCK_TILES || spec.depth > SCATTER_BLOCK_TILES) continue;
    const corner = SCATTER_BLOCKS[block]!;
    // Jitter inside the quadrant so props are not all pinned to the same corner of every room.
    const slack = {
      x: Math.max(0, SCATTER_BLOCK_TILES - spec.width),
      y: Math.max(0, SCATTER_BLOCK_TILES - spec.depth),
    };
    out.push({
      kind,
      tx: corner.tx + (slack.x === 0 ? 0 : hashRoom(roomId, i * 2 + 7) % (slack.x + 1)),
      ty: corner.ty + (slack.y === 0 ? 0 : hashRoom(roomId, i * 2 + 8) % (slack.y + 1)),
    });
  }
  return out;
}

/**
 * Which prop standing in this room answers to a word, if any.
 *
 * Whole-word and case-blind, the way `find_ex_description` (`actinf.c:671`) matches — a prefix
 * match would let `look s` hit a statue while the player meant south, and direction already wins
 * that argument earlier in `lookAt`.
 *
 * Takes the room's own list rather than a room, so the rules stay free of `world.ts` shapes and
 * this can be asked about a hypothetical arrangement in a test.
 */
export function sceneryNamed(
  scenery: readonly RoomScenery[] | undefined,
  word: string,
): RoomScenery | undefined {
  if (!scenery?.length || !word) return undefined;
  const needle = word.toLowerCase();
  for (const prop of scenery) {
    if (SCENERY[prop.kind]?.keywords.includes(needle)) return prop;
  }
  return undefined;
}
