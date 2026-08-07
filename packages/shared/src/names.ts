/**
 * The character name law — owner's rule, 2026-08-08, set while the account door was being built:
 * *"no numbers or special characters and no rude or crude words and no mispelled words to try and
 * get around it… no well known dnd character names also."*
 *
 * The structural half is a transcription of `nanny.c:1495` `_parse_name`: letters only, 2–12 of
 * them (`MAX_NAME_LENGTH 12`, `structs.h:137`), and a reserved-word list — the source calls its
 * array `smart_ass[]`, which says what it is for. The source *refuses* interior capitals; we
 * normalise them instead ({@link canonicalCharacterName}), because "WESTSTAR" is a caps-lock
 * accident, not an offence.
 *
 * The taste half is policy, not transcription, and it is **a fence, not a wall**: the profanity
 * check normalises the obvious evasion spellings (ph→f, sch→sh, y→i, doubled letters collapsed)
 * before matching, so `Schitthead` and `PhuckPhace` die exactly as typed names, but a determined
 * adolescent will always out-spell a word list. The operator's rename powers are the real
 * backstop; this list only keeps the door from being embarrassing on its own.
 *
 * Enforced at **minting only**. A character that already has a save file predates the law and is
 * grandfathered — `aldric11` keeps working — because retroactively orphaning saved characters over
 * a digit would cost more than the digit does.
 *
 * Only new-character creation reads this file. Account names stay on `slugify`'s rules: they are
 * not spoken, waved or rendered in the world — the character is the public name.
 */

/** `structs.h:137` MAX_NAME_LENGTH — the source's cap, kept. */
export const MAX_CHARACTER_NAME = 12;
export const MIN_CHARACTER_NAME = 2;

/**
 * Words a name may not be, transcribed from `_parse_name`'s `smart_ass[]`: everything the parser
 * itself needs to mean something else. Exact matches, after lowercasing.
 */
const RESERVED = new Set([
  'someone', 'somebody', 'me', 'self', 'all', 'group', 'local', 'them', 'they', 'nobody', 'any',
  'something', 'other', 'no', 'yes', 'north', 'east', 'south', 'west', 'up', 'down', 'shape',
  'shadow', 'northeast', 'southeast', 'northwest', 'southwest', 'nw', 'ne', 'sw', 'se', 'guide',
  'he', 'she', 'it', 'him', 'his', 'her', 'boy', 'girl', 'man', 'woman', 'mail', 'male', 'female',
  // The source blocks its own game's name; we block ours and its world's.
  'mygame', 'toril', 'faerun',
]);

/**
 * Rude roots, matched as substrings of the *normalised* name. Kept short and unambiguous on
 * purpose: every root here must be something no honest fantasy name contains, because a substring
 * match has no mercy — `ass` is deliberately absent (Cassandra, Bassim) and handled as an exact
 * word below.
 */
const RUDE_ROOTS = [
  'fuk', 'shit', 'kunt', 'kok', 'dild', 'piss', 'tits', 'twat', 'wank', 'slut', 'whore', 'huor',
  'nigg', 'fag', 'spik', 'kike', 'rape', 'penis', 'vagin', 'anal', 'anus', 'semen', 'rektum',
  'bich', 'biatch', 'asshole', 'asshat', 'arse',
];

/** Rude words that are only rude as the *whole* name, not inside one (`Bhorel` is not `hore`). */
const RUDE_EXACT = new Set(['ass', 'hor', 'hore', 'poo', 'wee', 'sex', 'gay', 'dik', 'kum', 'tit']);

/**
 * Names everyone at the table has already met. Exact match after normalisation, not substrings —
 * `Bruen` is somebody's own invention, `Bruenor` is a guest appearance. Forgotten Realms first
 * (this is Toril, they would be *impersonation*, not homage), then the D&D canon a table shouts
 * on sight.
 */
const FAMOUS = new Set([
  // Drizzt's book-shelf.
  'drizzt', 'dryzzt', 'wulfgar', 'bruenor', 'cattibrie', 'regis', 'artemis', 'entreri',
  'jarlaxle', 'zaknafein', 'gromph', 'montolio', 'guenhwyvar',
  // Faerûn's names in lights.
  'elminster', 'volo', 'volothamp', 'khelben', 'alustriel', 'laeral', 'manshoon', 'szass',
  'halaster', 'fzoul', 'gauntlgrym',
  // Powers of Toril. A player may worship one; they may not *be* one.
  'mystra', 'shar', 'selune', 'bhaal', 'myrkul', 'bane', 'cyric', 'ao', 'tempus', 'kelemvor',
  'ilmater', 'torm', 'tymora', 'beshaba', 'umberlee', 'malar', 'loviatar', 'talos', 'auril',
  'lolth', 'lloth', 'corellon', 'moradin', 'garl', 'yondalla', 'gruumsh', 'maglubiyet',
  // The wider canon: archmages of the spell names, dragons of the alignment chart.
  'mordenkainen', 'tasha', 'bigby', 'otiluke', 'melf', 'tenser', 'rary', 'drawmij', 'nystul',
  'leomund', 'evard', 'otto', 'vecna', 'kas', 'strahd', 'azalin', 'soth', 'acererak',
  'tiamat', 'bahamut', 'asmodeus', 'orcus', 'demogorgon', 'graz', 'grazzt', 'zariel', 'vlaakith',
  // Krynn tourists.
  'raistlin', 'caramon', 'tanis', 'sturm', 'tasslehoff', 'kitiara', 'laurana', 'dalamar',
  'fizban', 'lordsoth',
  // The Sword Coast's most recent celebrities.
  'minsc', 'imoen', 'jaheira', 'sarevok', 'irenicus', 'viconia', 'astarion', 'karlach',
  'shadowheart', 'laezel', 'halsin', 'minthara', 'gortash', 'ketheric', 'orin',
]);

/**
 * Folds the evasion spellings down before any list is consulted: lowercase, collapse doubled
 * letters, then the sound-alike substitutions rude words actually arrive in. Ordered — `sch` must
 * fold before doubles would split it, `ph` before anything eats the `h`.
 */
export function normaliseForMatching(name: string): string {
  let folded = name.toLowerCase();
  folded = folded.replace(/sch/g, 'sh');
  folded = folded.replace(/ph/g, 'f');
  folded = folded.replace(/(.)\1+/g, '$1');
  folded = folded.replace(/y/g, 'i');
  folded = folded.replace(/z/g, 's');
  folded = folded.replace(/q/g, 'k');
  folded = folded.replace(/x/g, 'ks');
  folded = folded.replace(/ck/g, 'k');
  folded = folded.replace(/c/g, 'k');
  return folded;
}

/** `weststar` → `Weststar`, `WESTSTAR` → `Weststar`. The stored, rendered, waved-at spelling. */
export function canonicalCharacterName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? trimmed : trimmed[0]!.toUpperCase() + trimmed.slice(1).toLowerCase();
}

/**
 * Why this may not be a new character's name — or `undefined` when it may.
 * Reasons are written for the player who typed it, not the operator: they are wire-visible
 * (`authFailed.reason`) and land under the picker's caret.
 */
export function characterNameProblem(raw: string): string | undefined {
  const name = raw.trim();
  if (name.length < MIN_CHARACTER_NAME) return 'a name needs at least two letters';
  if (name.length > MAX_CHARACTER_NAME) return `a name can carry at most ${MAX_CHARACTER_NAME} letters`;
  if (!/^[A-Za-z]+$/.test(name)) return 'letters only — no numbers, spaces or marks';
  const lower = name.toLowerCase();
  if (RESERVED.has(lower)) return 'that word already means something here';
  const folded = normaliseForMatching(name);
  if (RUDE_EXACT.has(lower) || RUDE_EXACT.has(folded)) return 'not that one';
  for (const root of RUDE_ROOTS) {
    if (lower.includes(root) || folded.includes(root)) return 'not that one';
  }
  if (FAMOUS.has(lower) || FAMOUS.has(folded)) return 'that name is already taken — by the books';
  return undefined;
}
