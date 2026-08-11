/**
 * Terrain inference — the name rules.
 *
 * The zMUD mapper database has no sector column — mappers only ever needed geometry. The `Color`
 * column looked promising but 93% of rooms carry the default value, so it is annotation rather than
 * data. That leaves the room and zone *text* as the only signal, so we infer.
 *
 * This is deliberately a transparent rule table rather than anything clever: it is wrong in
 * predictable ways, and a human can fix it by editing one line. Every room also keeps the evidence
 * that produced its guess, so a bad rule is traceable.
 *
 * ## Two tiers, and what each is for
 *
 * - **Words** match whole tokens. This is the workhorse, and its biggest historical failures were
 *   mundane: missing plurals (`\btunnel\b` fails on "a Maze of Tunnels" — 546 rooms), missing
 *   vocabulary (`passage`? `labyrinth`? `sewer`? `way`?), and ignoring the mapper's own literal
 *   annotations — hundreds of rooms end in "(Water)" or "(No Ground)" because the *mapper* knew.
 * - **Suffixes** match the ends of compound tokens, which is what Forgotten Realms places are made
 *   of: Night**wood**, Ever**moor**, Skull**port**, Hul**burg**, Dark**tree**. A word rule cannot see
 *   into a compound because `\b` needs a non-word character, and "the regex finds no word boundary
 *   inside Nightwood" was the type case this tier exists for.
 *
 * The suffix table is deliberately short and high-precision, because these guesses go on to *seed
 * graph diffusion* (see `diffuse.ts`) and a wrong seed spreads. The survey that shaped it also
 * supplied the cautionary example for anyone tempted to extend it cheaply: `-ice` looks like an
 * arctic suffix until it classifies "An Off**ice**" and "An Apprent**ice**'s Abode" as glacier.
 *
 * ## What is deliberately absent
 *
 * Connective tissue — "A Bend in the Passage", "A Dead End", "A T-intersection" — gets **no rule at
 * all**, on purpose. A passage between city rooms is city and a passage between cave rooms is cave;
 * any word we picked would be wrong half the time, and these rooms are exactly what the diffusion
 * stage answers from context. Absence of vocabulary here is an instruction to that stage, not a gap.
 *
 * The room *description* is also not consulted: prose mentions trees inside taverns far too often,
 * and testing showed it made results worse rather than better.
 */

import type { Sector } from '@mygame/shared';

interface Rule {
  readonly sector: Sector;
  readonly patterns: readonly RegExp[];
}

/**
 * Ordered most-specific first — the first match wins. Interior and structural words come before
 * everything else, because "the forest temple" is an interior, not a forest.
 *
 * **Landscape words come before road and city, and this ordering was wrong until 2026-08-11.** The
 * table used to read water, cave, inside, *road, city*, fortifications, then the landscape words —
 * so `/\b(road|...|path|...)\b/i` fired on "A Forest Path" before `/\bforest\b/i` ever got a turn,
 * and the room came out `road`. Swept the built world for names carrying both a landscape word and a
 * road/city word: **444 distinct room names** do, "A Dark Forest Path" and "A Path Through the Lizard
 * Marsh" among them, and under the old order every one of them lost its biome. The fix reads
 * `road`/`city` as *dressing on top of* a biome rather than a biome of their own: a path, trail or
 * street is not a distinct kind of ground, it is a description of what someone built across one, so
 * when a name carries both, the landscape word is the more specific claim about what is actually
 * underfoot and now wins. City settlement words move with them for the same reason — "the market in
 * the hills" is a hills room with a market in it before it is a city.
 *
 * **Known trade-off, accepted rather than special-cased:** of those 444 names, 7 use a structural
 * word — `bridge`, `gate`, `pier`, `wharf`, `dock` — rather than a bare route word, e.g. "A Bridge of
 * Ice" (now `arctic`, was `road`). A bridge is arguably infrastructure first regardless of what it
 * crosses, which would argue for carving it out the way the fortification words below are carved out
 * of `city`. Left alone here: 7 rooms is not enough signal to trust a carve-out over, and `-bridge`
 * already outranks `-ridge` at the suffix tier below for the compound-name case, which is the one
 * this project's own room names actually rely on ("Zundbridge"). If the harvest or a future survey
 * turns up a real population of "X Bridge" rooms that should stay `road`, split `bridge` into its own
 * rule ahead of the landscape block the way fortifications are split out of `city`.
 *
 * The mapper's own "(Water)" / "(No Ground)" annotations sit near the *bottom*: they are true but
 * generic, so "The Stump Bog (Water)" must hit `swamp` on its own name first and only an otherwise
 * anonymous water room falls through to the marker.
 */
const RULES: readonly Rule[] = [
  { sector: 'shallow_water', patterns: [/\bford\b/i, /\bshallows?\b/i, /\bwading\b/i, /\bshore(line)?\b/i, /\bbeach\b/i, /\bpool\b/i, /\bstreams?\b/i, /\bbrook\b/i] },
  { sector: 'underwater', patterns: [/\bunderwater\b/i, /\bsunken\b/i, /\bsea ?bed\b/i, /\boceans? floor\b/i] },
  { sector: 'deep_water', patterns: [/\bocean\b/i, /\bsea\b/i, /\bdeep water\b/i, /\bwaves\b/i, /\blake\b/i, /\bharbou?r\b/i, /\brivers?\b/i] },

  { sector: 'cave', patterns: [/\bcave(rn)?s?\b/i, /\bgrotto\b/i, /\btunnels?\b/i, /\bmines?\b/i, /\bunderdark\b/i, /\bcrevice\b/i, /\bfissure\b/i, /\bmazes?\b/i, /\blabyrinth\b/i, /\bsewers?\b/i, /\bshafts?\b/i, /\bcatacombs?\b/i] },
  {
    sector: 'inside',
    patterns: [
      /\b(inn|tavern|shop|store|smithy|forge|temple|shrine|hall|chamber|room|cellar|kitchen|bedroom|library|study|vault|crypt|tomb|dungeon|prison|cell|barracks|guild|academy|throne)\b/i,
      /\b(inside|interior|indoors?|foyer|corridor|hallway|stairwell|landing|attic|basement)\b/i,
      /\b(homes?|office|abode|stables?|bank)\b/i,
    ],
  },

  // Landscape/biome words — see the ordering note above for why these now sit ahead of road/city.
  // Relative order among these seven is unchanged from before the fix; only their position moved.
  { sector: 'swamp', patterns: [/\bswamp\b/i, /\bmarsh(land)?\b/i, /\bbog\b/i, /\bfen\b/i, /\bmire\b/i, /\bmoors?\b/i] },
  { sector: 'desert', patterns: [/\bdesert\b/i, /\bdune(s)?\b/i, /\bsand(s|y)?\b/i, /\boasis\b/i, /\bwaste(land)?s?\b/i] },
  { sector: 'arctic', patterns: [/\b(glacier|ice|icy|frozen|snow|tundra|frost|arctic)\b/i] },
  { sector: 'mountain', patterns: [/\bmountain\b/i, /\bpeak\b/i, /\bsummit\b/i, /\bcliff\b/i, /\bledge\b/i, /\bcrag\b/i, /\bascent\b/i, /\bslope\b/i, /\bcanyon\b/i, /\bravine\b/i] },
  { sector: 'hills', patterns: [/\bhill(s|side|top)?\b/i, /\bknoll\b/i, /\bridge\b/i, /\bfoothills\b/i, /\bdowns\b/i] },
  { sector: 'forest', patterns: [/\b(forest|wood(s|land)?|grove|thicket|copse|jungle|glade|canopy|timber)\b/i, /\btrees?\b/i] },
  { sector: 'field', patterns: [/\b(field|meadow|plain(s)?|grass(land|y)?|pasture|farm(land)?|clearing|steppe|prairie)\b/i] },

  { sector: 'road', patterns: [/\b(road|highway|trail|path|street|avenue|lane|bridge|causeway|alley|boulevard|way|ride)\b/i, /\bgate(house|way)?\b/i] },
  { sector: 'city', patterns: [/\b(city|town|village|market(place)?|square|plaza|courtyard|dock|wharf|pier|port|bazaar|walls?)\b/i] },
  /**
   * Fortifications, *after* the city words rather than among them, which is where they used to sit.
   * Measured against the Duris harvest, rooms named for a castle or keep are its interiors three
   * times out of four — "Within IceCrag Castle" is a hall, not a street — so the bare fortification
   * word now reads as inside, while "The Castle Courtyard" still hits `city` on `courtyard` and
   * "Castle Road" is still a road, because those rules fire first.
   */
  { sector: 'inside', patterns: [/\b(castle|keep|fort(ress)?|tower|citadel)\b/i] },

  /**
   * Passages, below every landscape word, so "A Mountain Passage" is a mountain and "A Forest
   * Passageway" a forest before a bare "A Bend in the Passage" falls through to cave. Cave rather
   * than inside because the survey found them overwhelmingly in dug and delved zones — Undermountain
   * alone holds hundreds — and measured against the harvest, the road-flavoured guesses diffusion
   * used to reach for here were its single largest source of error.
   */
  { sector: 'cave', patterns: [/\bpassage(way)?s?\b/i] },

  // The mapper's own annotations. Late, so a specific name wins first — see the header.
  { sector: 'shallow_water', patterns: [/\(water\)/i] },
  { sector: 'air', patterns: [/\(no ground\)/i] },

  { sector: 'air', patterns: [/\b(sky|cloud|aloft|midair|floating)\b/i] },
  { sector: 'astral', patterns: [/\bastral\b/i, /\bethereal\b/i, /\bplane of\b/i, /\bvoid\b/i] },
];

/**
 * Compound-name suffixes: `(stem)(suffix)` as one token, matched when no whole word fired.
 *
 * **Order is priority**, exactly as in {@link RULES}, and one ordering is load-bearing: `bridge`
 * before `ridge`, because every "Zundbridge" also ends in "ridge" and a drawbridge is not a hill.
 *
 * Each entry requires a stem of at least {@link MIN_STEM} letters, so the bare word never matches
 * here — "the Port" is the word tier's business; this tier exists for "Skullport". `-ton` is
 * deliberately missing however tempting the place-names are: "skeleton" ends in it.
 *
 * **`-shire`, `-fell` and `-holt` measure zero hits in the current 46,508-room build** — swept the
 * built world the same way as `-wood` (18 distinct tokens) and `-moor` (1: "Evermoor") below, and
 * came back empty for all three. Added anyway, because M1's brief lists them by name and a rule that
 * costs nothing today is cheap insurance against the next Duris drop or authored zone that uses one.
 * Sectors picked by ordinary toponymy rather than measurement, same as any other rule here before a
 * survey gives it evidence: `-holt` is Old English for a small wood or copse (compare "Northolt") —
 * `forest`. `-fell` is high open moorland, the Lake District sense ("Scafell"), walkable ground
 * rather than a sheer peak — `hills`, alongside `-ridge`. `-shire` is administered countryside, not
 * a dense settlement — `field`, alongside `-dale`/`-vale`. All three keep {@link MIN_STEM}'s stem
 * requirement, and none collides with an existing suffix or a common English word at that length
 * (checked by hand: nothing plausible ends "-shire"/"-fell"/"-holt" at 7+ letters the way "office"
 * ends "-ice").
 */
const SUFFIX_RULES: readonly { readonly sector: Sector; readonly suffixes: readonly string[] }[] = [
  { sector: 'road', suffixes: ['bridge', 'way'] },
  { sector: 'forest', suffixes: ['woods', 'wood', 'trees', 'tree', 'glen', 'holt'] },
  { sector: 'swamp', suffixes: ['moors', 'moor', 'marsh', 'bog', 'fen', 'mire'] },
  { sector: 'city', suffixes: ['port', 'haven', 'burgh', 'burg', 'town'] },
  { sector: 'mountain', suffixes: ['crag', 'peak'] },
  { sector: 'hills', suffixes: ['ridge', 'fell'] },
  { sector: 'field', suffixes: ['dale', 'vale', 'shire'] },
];

const MIN_STEM = 3;

/** Where a guess came from, most confident first. The diffusion stage treats only `default` as unlabelled. */
export type TerrainSource = 'room' | 'room-suffix' | 'zone' | 'zone-suffix' | 'default';

export interface TerrainGuess {
  readonly sector: Sector;
  /** Which rule fired, kept so a wrong guess can be traced back to one line of the table. */
  readonly matched: string | undefined;
  readonly source: TerrainSource;
}

function matchWords(text: string): { sector: Sector; matched: string } | undefined {
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) return { sector: rule.sector, matched: pattern.source };
    }
  }
  return undefined;
}

function matchSuffixes(text: string): { sector: Sector; matched: string } | undefined {
  // Tokens are letter runs, so "Wyllowwood's" and "Stump-Bog" both split where a reader would.
  const tokens = text.toLowerCase().split(/[^a-z]+/);
  for (const rule of SUFFIX_RULES) {
    for (const suffix of rule.suffixes) {
      for (const token of tokens) {
        if (token.length >= suffix.length + MIN_STEM && token.endsWith(suffix)) {
          return { sector: rule.sector, matched: `-${suffix}` };
        }
      }
    }
  }
  return undefined;
}

/**
 * Guesses terrain from a name, in confidence order:
 * room words → room suffixes → zone words → zone suffixes → default.
 *
 * The room's own name always outranks the zone's, whatever the tier — a room called "A Small
 * Chamber" is an interior even in a zone called "The Nightwood", and "The Nightwood" is a forest
 * even in a zone whose name says nothing. Within one name, a whole word outranks a compound's tail.
 */
export function inferSector(roomName: string, zoneName: string): TerrainGuess {
  const roomWord = matchWords(roomName);
  if (roomWord) return { ...roomWord, source: 'room' };

  const roomSuffix = matchSuffixes(roomName);
  if (roomSuffix) return { ...roomSuffix, source: 'room-suffix' };

  const zoneWord = matchWords(zoneName);
  if (zoneWord) return { ...zoneWord, source: 'zone' };

  const zoneSuffix = matchSuffixes(zoneName);
  if (zoneSuffix) return { ...zoneSuffix, source: 'zone-suffix' };

  // 'field' is the least-wrong default: it renders as open ground and reads as "unclassified"
  // rather than asserting something specific. The diffusion stage treats exactly these rooms as
  // unlabelled and fills them from their neighbours.
  return { sector: 'field', matched: undefined, source: 'default' };
}
