/**
 * The `hair` command's whole decision, as a pure function — the parse, the three refusals and the
 * prose.
 *
 * `commands.ts`'s split, one verb further along: the table and the parser are pure and the handler
 * lives in `index.ts` because it needs sockets, a simulation and a world. What is *here* is the part
 * that needs none of the three and is the part worth testing — which word means which style, what a
 * player is told when it means none, and exactly what the room sees. `index.ts` is left with four
 * lines: send, set, resync, announce.
 *
 * ## Why a verb at all, when it should be a creation question
 *
 * It should be. M7b skipped hair on exactly that reasoning: *"hair is a character-creation identity
 * field, and creation still lives in the 2D Phaser client, which has no way to collect one."* Still
 * true. The ruling for this slice is that it need not block the feature — `appearance.defaultHairFor`
 * hashes the character's own name so nobody is bald by accident, and this verb is how a player
 * overrides it. When creation moves to the 3D client its picker writes the same field, and this stays
 * as the way to change your mind.
 *
 * ## The numbering is a contract
 *
 * `hair 3` means the third row of {@link hairChoices}, which is `appearance.HAIR_STYLES`' own order
 * with `bald` appended. That constant is documented append-only for this reason: a player who has
 * learnt that their hair is `hair 4` should not find that a new style has moved it.
 */

import { BALD, HAIR_STYLES } from '@mygame/shared';

/** One row of the list a bare `hair` prints. */
export interface HairChoice {
  /** 1-based, and the number `hair <n>` selects. */
  readonly n: number;
  readonly id: string;
  readonly label: string;
}

/**
 * Every hairstyle a player may pick, numbered, with {@link BALD} last.
 *
 * Built rather than stored so the numbering cannot drift from the catalogue: there is one list, and
 * the row number is its index.
 */
export function hairChoices(): readonly HairChoice[] {
  const rows = HAIR_STYLES.map((style, index) => ({ n: index + 1, id: style.id, label: style.label }));
  return [...rows, { n: rows.length + 1, id: BALD, label: 'shaven bare' }];
}

/** How a style reads in prose — *"You wear your hair worn long."* Falls back to the id it does not know. */
export function hairLabel(id: string): string {
  return hairChoices().find((row) => row.id === id)?.label ?? id;
}

/**
 * What a `hair` line resolves to. Four shapes, and every one of them is something to say.
 *
 * A discriminated union with a `t` tag, `CLAUDE.md`'s convention for exactly this: the caller has to
 * handle each case, and adding a fifth refusal makes the compiler point at the handler.
 */
export type HairOutcome =
  /** `hair` with no argument: read the list. */
  | { readonly t: 'list'; readonly text: string }
  /** A refusal, already worded. `reason` exists so a test can name the case it is checking. */
  | { readonly t: 'refuse'; readonly reason: 'range' | 'unknown' | 'ambiguous' | 'already'; readonly text: string }
  /** A change. `you` is the second person, `room` is `act.ts`'s per-observer render. */
  | {
      readonly t: 'change';
      readonly id: string;
      readonly label: string;
      readonly you: string;
      readonly room: (who: string) => string;
    };

/**
 * The whole command, given what was typed and what the character's hair currently is.
 *
 * ## Resolution order, and the one place this parts company with `lookupCommand`
 *
 * A number first (out of range refuses with the count), then an exact id, then a **unique** prefix.
 * The command table resolves an ambiguous prefix by *table order* and that is right there — the order
 * is a rule players learn with their fingers and Diku has taught it for thirty years. A cosmetic list
 * that may be appended to has no such contract, so `bu` silently meaning `buns` today and `buzzed`
 * tomorrow would be a worse bargain than being asked for one more letter. It refuses, and names both.
 *
 * `current` is what the character's hair *is*, resolved (so a player who has chosen nothing passes
 * their deterministic default). Choosing it again is refused, and the refusal is the useful kind: it
 * says what your hair is and it stops a no-op resync going to every watcher in the room.
 */
export function hairCommand(argument: string, current: string, covered: boolean): HairOutcome {
  const choices = hairChoices();
  const word = argument.trim().toLowerCase();

  if (!word) {
    return {
      t: 'list',
      text: [
        `Your hair is ${hairLabel(current)}.${covered ? ' &+LYour headgear is covering it.&N' : ''}`,
        ...choices.map(
          (row) =>
            `  ${String(row.n).padStart(2)}. ${row.id.padEnd(8)} ${row.label}` +
            (row.id === current ? '  &+Y(yours)&N' : ''),
        ),
        '&+LChoose with "hair <name>" or "hair <number>".&N',
      ].join('\n'),
    };
  }

  const chosen = pick(word, choices);
  if ('reason' in chosen) return { t: 'refuse', reason: chosen.reason, text: chosen.text };

  if (chosen.id === current) {
    return { t: 'refuse', reason: 'already', text: `Your hair is already ${hairLabel(current)}.` };
  }

  const label = hairLabel(chosen.id);
  return {
    t: 'change',
    id: chosen.id,
    label,
    you: chosen.id === BALD ? 'You shave your head bare.' : `You wear your hair ${label}.`,
    // Rendered per observer rather than formatted once, `act.ts`'s rule: somebody standing in the dark
    // hears that *someone* changed their hair, and does not read a name off the log.
    room: (who) =>
      chosen.id === BALD ? `${capitalise(who)} shaves their head bare.` : `${capitalise(who)} now wears their hair ${label}.`,
  };
}

/** One typed word to a row, or the refusal it earns. */
function pick(
  word: string,
  choices: readonly HairChoice[],
): HairChoice | { readonly reason: 'range' | 'unknown' | 'ambiguous'; readonly text: string } {
  if (/^\d+$/.test(word)) {
    const row = choices.find((candidate) => candidate.n === Number(word));
    if (row) return row;
    return {
      reason: 'range',
      text: `There are ${choices.length} hairstyles. Pick 1-${choices.length}, or type "hair" for the list.`,
    };
  }

  const exact = choices.find((row) => row.id === word);
  if (exact) return exact;

  const prefixed = choices.filter((row) => row.id.startsWith(word));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) {
    return {
      reason: 'ambiguous',
      text: `"${word}" could be ${prefixed.map((row) => row.id).join(' or ')}. Be more specific.`,
    };
  }
  return { reason: 'unknown', text: `There is no hairstyle called "${word}". Type "hair" for the list.` };
}

/** First letter up. A local copy rather than an import, because this module must stay pure. */
function capitalise(name: string): string {
  return name.length === 0 ? name : `${name[0]!.toUpperCase()}${name.slice(1)}`;
}
