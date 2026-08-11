/**
 * Choosing what a creature *looks like* from what it is called — the owner's ask, 2026-08-11:
 * *"can we get their image from their name and description instead of relying on the race."*
 *
 * Right, and the measurement says why. All **1,503 mob templates draw `human`**, and it is not for
 * want of data: twelve distinct Duris race codes are harvested and present. `HUMANOID_RACES` simply
 * maps every one of them to `'human'`, because LPC had no other body when that table was written.
 * Race is also the wrong key even once it does something — it says `H` (Humanoid) for a kobold, a
 * faerie and a bandit alike, which is the very complaint. **The name is the information.**
 *
 * ## There is no description, and the prompt had to be built around that
 *
 * Measured across all 1,503: the only text a template carries is `name` and `keywords`, plus `race`
 * and `level` as facts. There is no `description` and no room line. So this is a **short-string**
 * classification — *"the kobold shaman", keywords kobold/shaman, race H, level 23* — which is
 * harder than A7g's item problem had it, and is the reason the prompt hands over the race and the
 * level too: they are weak signals but they are the only other signals there are.
 *
 * ## Two passes, and the cheap one goes first
 *
 * A7g's own shape. **`shapeFromWords` is an exact-word matcher** over the creature vocabulary, and
 * it settles anything whose name says what it is — a kobold is a lizard, a worg is a wolf, a
 * skeleton is a skeleton. It is deterministic, free, and auditable, and it covers the cases nobody
 * would want a model's opinion on.
 *
 * Whatever it cannot answer is a question for the model, which is the thing A7g learned a small
 * local model is reliably good at: *this creature, these candidate shapes, which one?* A word
 * matcher cannot know that *"a scaled hunter"* is a lizard or that *"Grimfang"* is probably not a
 * human, and a model should not be asked whether *"a kobold"* is a kobold.
 *
 * ## What is deliberately not decided here
 *
 * **Nothing is written.** This module is prompt-and-parse and holds no I/O, exactly as `artpick.ts`
 * splits from `artsweep.ts` — the parts hardest to get right are the parts worth testing without a
 * model in the loop, and a sweep that cannot be unit-tested is a sweep nobody re-runs.
 */

/** What a template gives us to go on. Measured: this is all of it. */
export interface MobFacts {
  readonly vnum: number;
  /** Display name, colour codes and all — {@link plainName} strips them. */
  readonly name: string;
  readonly keywords?: readonly string[];
  /** Duris' race code. A weak signal, passed to the model rather than trusted here. */
  readonly race?: string;
  readonly level?: number | string;
}

/** A body and a head, both by the pack's own shape word. */
export interface CreatureChoice {
  readonly body: string;
  readonly head: string;
}

/** The MUD's colour notation, out of the way before any word is matched. */
export function plainName(name: string): string {
  return name.replace(/&\+?./g, '').trim();
}

/**
 * Words that name a head shape outright.
 *
 * Keyed by the **ULPC shape**, valued by the words that mean it. Deliberately conservative: every
 * entry here is a word whose meaning is not in doubt, because the whole point of the first pass is
 * that it never needs a second opinion. Anything arguable is left for the model.
 *
 * `kobold -> lizard` is the one that earns its place — 42 of the world's 88 creature-named
 * templates are kobolds, and Duris' own race code for them is `H`.
 */
const SHAPE_WORDS: Readonly<Record<string, readonly string[]>> = {
  lizard: ['kobold', 'lizard', 'lizardman', 'lizardfolk', 'draconian', 'scaled', 'reptilian', 'saurian', 'troglodyte'],
  wolf: ['wolf', 'worg', 'warg', 'lupine', 'werewolf'],
  rabbit: ['rabbit', 'bunny', 'hare'],
  rat: ['rat', 'ratling', 'rodent'],
  mouse: ['mouse', 'mice'],
  pig: ['pig', 'hog', 'swine'],
  boarman: ['boar', 'boarman'],
  sheep: ['sheep', 'ram', 'ewe'],
  minotaur: ['minotaur', 'bull', 'taurus'],
  goblin: ['goblin', 'hobgoblin'],
  orc: ['orc', 'orcish'],
  troll: ['troll'],
  skeleton: ['skeleton', 'skeletal', 'bones'],
  zombie: ['zombie', 'ghoul', 'corpse'],
  vampire: ['vampire', 'vampiric'],
  alien: ['alien', 'illithid', 'mindflayer'],
};

/**
 * Words that name a build.
 *
 * Far weaker than the head words and used only as a nudge, because a body is mostly a *size*
 * judgement and the name rarely states one. `giant` and `ogre` reaching for `muscular` is the
 * useful case; everything else falls to the default.
 */
const BODY_WORDS: Readonly<Record<string, readonly string[]>> = {
  muscular: ['giant', 'ogre', 'troll', 'brute', 'huge', 'massive', 'hulking', 'warrior', 'guard', 'champion'],
  child: ['young', 'youth', 'child', 'cub', 'pup', 'kit', 'small', 'tiny', 'lesser', 'sprite', 'pixie', 'brownie'],
  teen: ['apprentice', 'novice', 'squire', 'lad', 'girl', 'boy'],
  skeleton: ['skeleton', 'skeletal'],
  zombie: ['zombie', 'ghoul'],
};

/**
 * Words that name a human **role**, and the reason this list exists rather than a prompt sentence.
 *
 * Measured over the full sweep, 2026-08-11: the model reads a job or a rank as a species. *"Sarlania,
 * The Cleric"* came back `minotaur`, *"a burly guardian"* came back `troll` six times over, *"a
 * duergar warrior"* came back `orc`, *"the ranger guild guardian"* came back `wolf`. **103 people
 * were wearing a monster's head**, and the prompt already said in as many words that a job does not
 * change the species — an 8B simply does not hold it against a name that sounds martial.
 *
 * So it is enforced in code instead, where it is deterministic and auditable. A monster word in the
 * name still overrules: *"a troll guard"* is a troll, because {@link shapeFromWords} answers first.
 */
const ROLE_WORDS: ReadonlySet<string> = new Set([
  'cleric', 'priest', 'priestess', 'mage', 'magician', 'wizard', 'sorcerer', 'witch', 'warlock',
  'guardian', 'guard', 'warrior', 'knight', 'squire', 'soldier', 'sentry', 'captain', 'lieutenant',
  'sergeant', 'watchman', 'merchant', 'trader', 'shopkeeper', 'smith', 'baker', 'farmer', 'cook',
  'maid', 'servant', 'slave', 'peasant', 'villager', 'thief', 'rogue', 'bandit', 'brigand',
  'assassin', 'scout', 'ranger', 'hunter', 'archer', 'bard', 'monk', 'paladin', 'lord', 'lady',
  'king', 'queen', 'prince', 'princess', 'duke', 'baron', 'sir', 'dame', 'master', 'mistress',
  'apprentice', 'adventurer', 'traveller', 'traveler', 'pilgrim', 'sailor', 'fisherman', 'miner',
  'woodsman', 'shepherd', 'healer', 'man', 'woman', 'boy', 'girl', 'child', 'elder', 'citizen',
  'noble', 'beggar', 'drunk', 'barbarian', 'spiritist', 'dicer',
]);

/**
 * Whether a name says *person doing a job* — in which case a monster head is a mistake.
 *
 * Only consulted for an answer the words did not corroborate, so it can never override a real
 * monster: `shapeFromWords` runs first and a troll guard stays a troll.
 */
export function namesAPerson(facts: MobFacts): boolean {
  const words = plainName(facts.name).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.some((w) => ROLE_WORDS.has(w));
}

/** The body a creature gets when nothing in its name suggests otherwise. */
export const DEFAULT_BODY = 'male';

function wordsOf(facts: MobFacts): Set<string> {
  const text = `${plainName(facts.name)} ${(facts.keywords ?? []).join(' ')}`.toLowerCase();
  return new Set(text.split(/[^a-z]+/).filter(Boolean));
}

/**
 * The shape a creature's own words name, or nothing.
 *
 * Whole words only, the same rule `find_ex_description` and the item matcher use: a prefix match
 * would make *"orchard keeper"* an orc and *"ratchet"* a rat, which is the class of mistake that
 * makes a bulk assignment untrustworthy and is very hard to spot in a list of 1,500.
 */
export function shapeFromWords(facts: MobFacts, available: readonly string[]): string | undefined {
  const words = wordsOf(facts);
  const offered = new Set(available);
  for (const [shape, triggers] of Object.entries(SHAPE_WORDS)) {
    if (!offered.has(shape)) continue;
    if (triggers.some((t) => words.has(t))) return shape;
  }
  return undefined;
}

/** The build a creature's own words suggest, defaulting to {@link DEFAULT_BODY}. */
export function bodyFromWords(facts: MobFacts, available: readonly string[]): string {
  const words = wordsOf(facts);
  const offered = new Set(available);
  for (const [body, triggers] of Object.entries(BODY_WORDS)) {
    if (!offered.has(body)) continue;
    if (triggers.some((t) => words.has(t))) return body;
  }
  return offered.has(DEFAULT_BODY) ? DEFAULT_BODY : (available[0] ?? DEFAULT_BODY);
}

/**
 * What the model is asked, for the ones the words could not settle.
 *
 * `artpick`'s three lessons, carried over. **The candidate list is given in full** — a model asked
 * for "a head" invents one, a model handed twenty picks from twenty. **The answer is one token**,
 * the shape word itself, because anything longer invites a sentence to parse. And **plainness is
 * stated**, because the failure mode of a creative model on this task is reaching for `minotaur`
 * when the honest answer is `human`: most of this world is people, and a roster where every guard
 * is a beast is worse than one where every guard is a man.
 */
export function buildMobPrompt(facts: MobFacts, shapes: readonly string[]): string {
  const name = plainName(facts.name);
  const keywords = (facts.keywords ?? []).join(', ');
  return [
    'You are picking a head sprite for a creature in a fantasy MUD.',
    '',
    `Creature: "${name}"`,
    keywords ? `Keywords: ${keywords}` : '',
    facts.race ? `Race code: ${facts.race}` : '',
    facts.level !== undefined ? `Level: ${facts.level}` : '',
    '',
    'Choose exactly one from this list:',
    shapes.join(', '),
    '',
    'Rules:',
    '- Answer with one word from the list and nothing else.',
    '- Most creatures in this world are ordinary people. Answer human unless the name names a',
    '  species that is not human.',
    '- A job, a rank, a title, a personality or a personal name does not change the species.',
    '  A bandit, a scout, a magician, a guard, a chieftain and a merchant are all people.',
    '- An elf, half-elf, dwarf, gnome, halfling, faerie or other humanoid is human here: the list',
    '  has no head for them and human is the closest true answer.',
    '- If nothing in the list fits the creature, answer human. Do not pick the nearest monster.',
    '',
    // **Few-shot, and each line is a mistake an 8B actually made.** Measured on 2026-08-11 over
    // twenty creatures: a half-elf scout came back `wolf`, a bandit `goblin`, a magician
    // `skeleton`, a treant `minotaur` — a 20% error rate, all of it reaching for a monster where
    // the honest answer was a person. Prose alone did not hold it; examples of the specific
    // confusions do, and they cost four lines of prompt.
    'Examples:',
    'a sneaky bandit -> human',
    'a tharnadian half-elf scout -> human',
    'an evil magician -> human',
    'the huge treant -> human',
    'a kobold youth -> lizard',
    'a rotting ghoul -> zombie',
    '',
    'Answer:',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * The model's answer turned back into a shape, or nothing.
 *
 * Whole-word again, and **longest first**, so a model that says `lizardfolk` is not read as
 * `lizard` by accident of ordering and one that rambles *"I would choose wolf"* still lands on
 * `wolf`. An answer naming two shapes is refused rather than guessed at: a coin toss recorded as a
 * decision is the thing a sweep must never do.
 */
export function readMobAnswer(text: string, shapes: readonly string[]): string | undefined {
  const words = new Set(text.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  const hits = [...shapes].sort((a, b) => b.length - a.length).filter((shape) => words.has(shape));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The sprite key a choice becomes — what a mob's `sprite` field stores and the client resolves.
 *
 * `body/head`, both the pack's own words, because a flat name would need a table mapping it back to
 * two layers and that table is the thing that drifts. The client splits on the slash and looks up
 * `body-<body>` and `head-shape-<head>-<variant>`; a key that names nothing draws the human it
 * always drew, which is the same degradation an unknown art id already gets.
 */
export function spriteKey(choice: CreatureChoice): string {
  return `${choice.body}/${choice.head}`;
}

/** The inverse, for the client and for anybody reading an override file. */
export function readSpriteKey(key: string): CreatureChoice | undefined {
  const [body, head] = key.split('/');
  return body && head ? { body, head } : undefined;
}
