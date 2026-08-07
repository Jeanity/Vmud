/**
 * Affects: one record for everything temporary.
 *
 * This is the phase-5b primitive, and the reason it exists is a claim about cost. Duris has exactly
 * one structure for a timed modifier — `struct affected_type` in `structs.h` — and builds buffs,
 * debuffs, damage-over-time markers, absorption pools, spell memorisation slots, innate cooldowns,
 * PvP timers, quest state and plain counters out of it. One list, one expiry pass, one persistence
 * path, one removal path, one display path. **Adding a new timed mechanic costs a row in a table and
 * no infrastructure at all**, and that is the whole of the argument
 * (`REFERENCE-mud-mechanics.md` §1.4, which calls it the single most transferable idea in the study
 * set). Build combat states, poison and cooldowns first and you get five parallel half-systems, and
 * the cost of unifying them afterwards is rewriting all five.
 *
 * ## What this file is not
 *
 * It knows nothing about light, rest, combat or any other mechanic. The catalogue below names types
 * and the module that owns each mechanic supplies the numbers — `light.ts` resolves a `light` affect
 * to a source, `vitals.ts` builds the rest affects, the server owns the lists. A primitive that
 * imported its own consumers would not be a primitive.
 *
 * ## Stats are recomputed from base. There is no `unapply`.
 *
 * `REFERENCE-mud-mechanics.md` §1.5, and the source comment it quotes says it plainly: *"for stats, it
 * just flat out recalcs them, no +/- about it, safer that way."* Any change — an affect landing, an
 * affect expiring, later a gear swap — strips the character to base and re-folds the whole list.
 * Incremental adjust-and-undo is the bug factory: one missed `unapply` and a character keeps a bonus
 * for ever, and the drift is invisible until someone notices they have 400 hit points.
 *
 * The functions here are the fold. {@link sumApply} totals a numeric location; {@link affectsFor}
 * hands the list for a location to whoever derives a non-numeric one (light is best-of, not a sum).
 * The single derivation point is `Simulation.recompute` — Duris' `affect_total`.
 *
 * ## One clock, not two
 *
 * Duris carries **two duration clocks in one field**: ordinary affects decrement once per game hour
 * in `affect_update()`, while affects flagged `AFFTYPE_SHORT` are measured in pulses and owned by a
 * scheduled `event_short_affect` — which is why removing one early has to find and neuter its event,
 * and why the handler must re-verify both that the character is alive and that the affect is still in
 * the list before touching either (`affects.c:1905`). Skip either half and it is a use-after-free.
 *
 * We have no coarse hour clock, so **we do not have that split**. Every duration is milliseconds,
 * decremented by the 100 ms simulation tick, and the whole hazard goes away: there is no second clock
 * to disagree with the first and no event holding a pointer to a record someone else may have freed.
 * That is the one place this file deliberately does less than the source.
 */

/* -------------------------------------------------------------------------- */
/* The record                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which derived stat an affect feeds — Duris' `APPLY_*` (`defines.h:820`).
 *
 * Duris has 58 of these. **We have eight, and every one has a reader**, which is the discipline this
 * project keeps for a reason: `ROADMAP.md` rule 1 exists because four mechanisms were written, tested
 * and never called, and a taxonomy of locations nothing derives from would be the same mistake spread
 * over a table. Rows get added when a consumer arrives, and no sooner.
 *
 * - `none` — no stat at all. The record is a *timer*: a marker, a counter, a cooldown. Duris'
 *   `APPLY_NONE`, and most of its `TAG_*` nodes are this.
 * - `light` — a **selector, not a sum**. Two torches are not a lantern, so the derivation is best-of
 *   over the candidates rather than addition; `context` carries the catalogue id and `light.ts` ranks
 *   them. This is the location that proves the fold has to hand out lists as well as totals.
 * - `hpRegen`, `manaRegen`, `moveRegen` — added to the per-minute base in `vitals.ts`. Duris'
 *   `APPLY_HIT_REG` / `APPLY_MANA_REG` / `APPLY_MOVE_REG`, which feed `points.hit_reg` and friends.
 * - `ac`, `hit` — **Phase 20 slice 5**, `APPLY_AC` / `APPLY_HITROLL`, folded by `refitCombat` beside
 *   the same numbers gear contributes. `ac` is in **our** AC points (higher is better), compressed at
 *   the producer through the one law items already use (`armourBonusFrom`), so a spell and a
 *   breastplate cannot come to different opinions about what armour is worth.
 * - `saves` — `APPLY_SAVING_SPELL`, summed into the save modifier where the save is rolled. Duris'
 *   sign convention kept: **negative helps the defender** (`sparser.c`'s "less is more"), and the ×5
 *   every modifier gets applies to this one too, which is why bless at `-1` is worth five points.
 */
export const APPLY_LOCATIONS = ['none', 'light', 'hpRegen', 'manaRegen', 'moveRegen', 'ac', 'hit', 'saves'] as const;

export type ApplyLocation = (typeof APPLY_LOCATIONS)[number];

/**
 * Behaviour bits — Duris' `AFFTYPE_*` (`structs.h:117`).
 *
 * A bit field rather than three booleans because that is what it is: a set of independent behaviours,
 * queried by test rather than by walk, and one number on the wire and in a save file. Duris has
 * fourteen; we have three, on the same rule as the locations above — a flag no code reads is a comment
 * pretending to be a mechanism.
 *
 * No `enum`: Node strips types at run time and rejects any construct that emits runtime code
 * (`CLAUDE.md` gotcha 3).
 */
export const AffectFlag = {
  None: 0,
  /**
   * Never written to the character file. `AFFTYPE_NOSAVE`.
   *
   * For effects that are a property of the situation rather than of the character — the rest cycle
   * below is the case in point: it is earned by sitting still for half a minute and is cheap to earn
   * again, so carrying it across a reconnect would be a way to bank one.
   */
  NoSave: 1 << 0,
  /**
   * Hidden from the display path. `AFFTYPE_NOSHOW`.
   *
   * Set on the carried light, which has had its own HUD line and its own log prose since Phase 1 —
   * listing it again under "affects" would say the same thing twice in two different vocabularies.
   */
  NoShow: 1 << 1,
  /**
   * Keeps counting down while the character is logged out. `AFFTYPE_OFFLINE`.
   *
   * The default is the opposite: a saved affect resumes with exactly the time it had, which is how
   * the carried light has behaved since it was persisted and is what a player expects of a torch they
   * were not holding. This flag is the opt-out, and it exists ahead of its first setter on purpose —
   * a cooldown or a PvP timer that pauses when you close the tab is a cooldown you dodge by closing
   * the tab, and the fix has to be a property of the affect rather than a special case in the loader.
   *
   * **It has a reader and no setter today.** See the inert-surface note in `HANDOFF.md`.
   */
  Offline: 1 << 2,
} as const;

export type AffectFlags = number;

/**
 * A duration that never runs out — Duris' own sentinel, `duration == -1` (`affects.c:4223`).
 *
 * `-1` rather than `Infinity` because affects are persisted as JSON and `JSON.stringify(Infinity)` is
 * `null`, so a permanent affect would come back from disk as a malformed one. A negative millisecond
 * count is not a value any real duration can take, so the sentinel cannot collide with one.
 */
export const UNLIMITED_DURATION = -1;

export interface Affect {
  /**
   * What caused this — a key into {@link AFFECT_TYPES}.
   *
   * **`type` is not a key**, and that is the single easiest thing to get wrong about this record
   * (`REFERENCE-mud-mechanics.md` §4.12). One cause installs *one node per location it touches*, so
   * several affects in a list legitimately share a type: `second_wind` is three nodes, one each for
   * the three regeneration locations. Everything that looks a type up therefore works on runs rather
   * than on single hits — {@link removeType} removes all of them, and the display path groups them.
   */
  readonly type: AffectType;
  /** Milliseconds left, or {@link UNLIMITED_DURATION}. Counted down by the simulation tick. */
  durationMs: number;
  readonly apply: ApplyLocation;
  /** How much, at that location. Ignored when `apply` is `none`. */
  readonly modifier: number;
  readonly flags: AffectFlags;
  /**
   * Optional payload, for a location whose value is not a number — Duris' `context` pointer.
   *
   * Today it is exactly one thing: the catalogue id of a light source. Kept a string rather than a
   * reference so that a record survives being written to a file and read back, and so that an id the
   * catalogue no longer recognises resolves to nothing instead of to a dangling object.
   */
  readonly context?: string;
  /**
   * Whether the {@link AffectKind.warnAtMs} warning has been given for this instance.
   *
   * A latch, and it has to be one: the warning is an *event* and an edge test alone would miss the
   * case that matters, which is a save resumed with less time left than the threshold. Not persisted —
   * being warned twice about the same torch across a reconnect is better than being warned never.
   *
   * It lives here rather than on the character, which is the small structural win the migration buys:
   * `Player.lightWarned` was a bespoke field for one mechanic, and this is the same latch that every
   * timed effect now gets for nothing.
   */
  warned: boolean;
}

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What a type *is*: how it reads, and whether it warns before it goes.
 *
 * This table is the registry the §1.4 claim cashes out in — a new timed mechanic adds a row here and
 * touches nothing else. The prose lives with the type rather than at the site that installs it,
 * because the expiry pass is generic: it does not know what expired, only that something did, and the
 * sentence has to come from somewhere the pass can reach. That is Duris' `wear_off_message` and its
 * `wear_off_message_index`, flattened into the one table.
 */
export interface AffectKind {
  readonly id: AffectType;
  /** How it reads in the HUD and in `affects`. */
  readonly name: string;
  /**
   * What the character is told when it lapses — Duris' `wear_off_message`.
   *
   * Absent means say nothing, which is right for anything that announces its own ending more
   * specifically. The carried light is the case: "your torch gutters and dies" names the source and
   * what it left behind, and a generic line as well would be a second, vaguer copy of it.
   */
  readonly wearOff?: string;
  /**
   * Fire an `expiring` event once, this far from the end.
   *
   * Only the carried light sets it, and the reason is the reason it was a bespoke field before: a
   * radius that drops from 3 to 2 between two ticks in a dark zone reads as the server glitching. Ten
   * seconds is about four room crossings — long enough to choose between pressing on and turning
   * back, short enough to still feel urgent.
   */
  readonly warnAtMs?: number;
}

/**
 * Every affect type in the game. Seven, and each of them has a live consumer.
 *
 * The list and the table are separate for the same reason `COMMANDS` and `COMMAND_REQUIREMENTS` are:
 * the list is the type and the table is the data, so a row added to one without the other is a type
 * error rather than a silent gap. It is also the only way to have {@link AffectKind.id} typed as an
 * affect type at all — a table that derived its own key type from itself would reference itself.
 */
export const AFFECT_TYPE_IDS = ['light', 'settling', 'second_wind', 'notch_physical', 'notch_mental', 'off_balance', 'casting', 'armor', 'bless', 'potion_sated'] as const;

export type AffectType = (typeof AFFECT_TYPE_IDS)[number];

/**
 * What each type is.
 *
 * `light` is the migration Phase 5b was placed before combat to force: it deletes a bespoke burn
 * timer rather than adding a parallel one, which is the honest test of whether this primitive is
 * general enough to be worth having.
 */
export const AFFECT_TYPES: Readonly<Record<AffectType, AffectKind>> = {
  /**
   * The carried light's burn.
   *
   * `context` is the source's catalogue id; `apply: 'light'` puts it in front of the derivation in
   * `light.ts`. Not `NoSave` — a torch that vanished on every reconnect was the bug `restoreLight`
   * exists to fix, and `node --watch` made that the normal case rather than an edge one.
   */
  light: {
    id: 'light',
    name: 'a light',
    warnAtMs: 10_000,
  },
  /**
   * Rest that has not been interrupted yet — the half-minute you have to sit still for.
   *
   * A pure timer: `apply: 'none'`, no modifier, nothing derived from it. Duris does exactly this with
   * `add_tag_to_char` and reads it back with `affect_timer`, and it is the idiom that makes "you have
   * to keep doing this for a while" one row rather than a counter field on the character.
   *
   * Deliberately **not** `NoShow`: watching it run down and turn into something is the phase's own
   * evidence, and it is also the honest interface — a mechanic that rewards patience has to tell you
   * how much patience is left, or it reads as a random event.
   */
  settling: {
    id: 'settling',
    name: 'settling into rest',
  },
  /**
   * The reward: flat regeneration on top of the base, for a minute, and it survives standing up.
   *
   * Three nodes of this one type — see {@link Affect.type}. It keeps running when you get to your
   * feet on purpose: an effect that only ever applied while resting would be adding a bonus to the
   * state that is already regenerating fastest, which is a buff you can never spend.
   */
  second_wind: {
    id: 'second_wind',
    name: 'second wind',
    wearOff: 'Your second wind fades.',
  },
  /**
   * The two skill-notch cooldowns — **Phase 19**, and they are two rather than one on purpose.
   *
   * Duris keeps exactly this pair (`TAG_PHYS_SKILL_NOTCH`, `TAG_MENTAL_SKILL_NOTCH`) at 5 and 10 real
   * minutes, so learning something physical does not slow learning something mental. A single shared
   * cooldown would make the two-category design in `skills.ts` unobservable, and an unobservable design
   * is one nobody can build on later.
   *
   * **Installed `NoShow`, and the display duty lives in the `skills` command** — which is not what
   * this comment used to claim. It argued *Shown*, on `settling`'s logic (a mechanic that rewards
   * patience has to say how much patience is left), and the install site quietly disagreed: the
   * affect list showing "learning (physical) 4:51" beside torches and wounds read as a debuff, so the
   * cooldown reports where a player actually asks the question — `skills` says *"you have learnt
   * something physical recently, and are learning more slowly"*. Reconciled 2026-08-07 in Phase 20's
   * first commit, before the spell cooldowns copy whichever precedent they read first. Still
   * **saved**, which matters more than it looks — an unsaved cooldown would make reconnecting the
   * fastest way to grind.
   */
  notch_physical: {
    id: 'notch_physical',
    name: 'learning (physical)',
    wearOff: 'You feel ready to learn something new.',
  },
  notch_mental: {
    id: 'notch_mental',
    name: 'learning (mental)',
    wearOff: 'Your mind feels ready to learn again.',
  },
  /**
   * Recovering from a bash or a kick — **Phase 19 slice 3**, and it is Duris' own mechanism rather than ours.
   *
   * `do_bash` does `set_short_affected_by(ch, SKILL_BASH, 2 * PULSE_VIOLENCE)` and `chance_roundkick` reads
   * it back to refuse a follow-up: *"you haven't reoriented yourself yet enough for another kick."* So the
   * cost of an ability is a timed affect on the person who used it, which is exactly what this list is for.
   *
   * **Shown**, on `settling`'s argument: a player whose kick was refused must be able to see why, and a
   * countdown is a better answer than a refusal message they have to remember. **Not saved** — it is at most
   * two rounds, and a lag that survived a reconnect would be a punishment for a dropped connection.
   */
  off_balance: {
    id: 'off_balance',
    name: 'off balance',
    wearOff: 'You recover your balance.',
  },
  /**
   * The wind-up itself — **Phase 20 slice 2**, and the reason it is an affect at all: `SelfView`
   * already renders affect rows with live countdowns, so the caster's own progress meter costs the
   * client nothing. **Shown**, obviously — a wind-up is the one state whose whole point is being
   * watched — and the `cast` event owns its end: completion and interruption both remove this
   * explicitly, so there is no `wearOff` sentence, because the spell's own completion line (or the
   * disruption line) is the sentence. Never saved: a cast does not survive a disconnect, exactly as
   * the source's `StopCasting`-on-extract has it.
   */
  casting: {
    id: 'casting',
    name: 'casting',
  },
  /**
   * The armor spell — **Phase 20 slice 5**, the first affect that changes a number a fight reads.
   *
   * One node, `apply: 'ac'`, its modifier compressed through `armourBonusFrom` at the producer so a
   * spell speaks the same armour language a breastplate does. **Shown and saved** — Duris saves
   * spell affects, and a ward that vanished on reconnect would make logging out the counterspell.
   * The wear-off sentence is the source's own for the ward going (`smagic.c:2854`).
   */
  armor: {
    id: 'armor',
    name: 'magic armor',
    wearOff: 'You suddenly feel less protected.',
  },
  /**
   * Bless — two nodes of one type, `hit` and `saves` (`spell_bless`, `magic.c:5145-5155`), which is
   * exactly the several-nodes-one-cause shape {@link Affect.type}'s comment warns about. Shown and
   * saved, as armor is.
   */
  bless: {
    id: 'bless',
    name: 'blessed',
    wearOff: 'Your blessing fades.',
  },
  /**
   * The potion cooldown — `TAG_POTION_TIMER` (`do_quaff`, `actoth.c:4109-4114`), three of the
   * source's ticks between draughts, which is what keeps a bag of fifty cures from being an
   * immortality button mid-fight. **Shown**, on `off_balance`'s argument: a refused quaff deserves
   * a countdown rather than a sentence to remember. Saved, so reconnecting is not the faster way
   * to drink twice.
   */
  potion_sated: {
    id: 'potion_sated',
    name: 'potion-sated',
    wearOff: '&+cYou feel ready to try another potion.&N',
  },
};

/**
 * Catalogue lookup for a type that arrived from outside the program — a save file, or the wire.
 *
 * The own-property check is not paranoia and the reasoning is `light.ts`'s: without it
 * `affectKind('toString')` hands back `Object.prototype.toString` typed as an {@link AffectKind}, and
 * the first read of `.name` produces something inexplicable several frames later.
 */
export function affectKind(type: string): AffectKind | undefined {
  return Object.hasOwn(AFFECT_TYPES, type) ? AFFECT_TYPES[type as AffectType] : undefined;
}

/* -------------------------------------------------------------------------- */
/* Building and querying                                                       */
/* -------------------------------------------------------------------------- */

export interface NewAffect {
  readonly type: AffectType;
  readonly durationMs: number;
  readonly apply?: ApplyLocation;
  readonly modifier?: number;
  readonly flags?: AffectFlags;
  readonly context?: string;
}

/**
 * One affect, with the defaults every field has when a mechanic does not care about it.
 *
 * A factory rather than object literals at each site so that adding a field to the record does not
 * mean finding every place one is built. `apply` defaults to `none` and `modifier` to 0, which
 * together are "this is a timer and nothing else" — the commonest shape by some distance.
 */
export function newAffect(spec: NewAffect): Affect {
  return {
    type: spec.type,
    durationMs: spec.durationMs,
    apply: spec.apply ?? 'none',
    modifier: spec.modifier ?? 0,
    flags: spec.flags ?? AffectFlag.None,
    ...(spec.context === undefined ? {} : { context: spec.context }),
    warned: false,
  };
}

export function hasFlag(affect: Affect, flag: number): boolean {
  return (affect.flags & flag) !== 0;
}

/** Whether anything in the list has this type. Cheaper than {@link affectsOfType} for a bare test. */
export function hasType(affects: Iterable<Affect>, type: AffectType): boolean {
  for (const affect of affects) if (affect.type === type) return true;
  return false;
}

/** Every node of one type — plural, because {@link Affect.type} is not a key. */
export function affectsOfType(affects: Iterable<Affect>, type: AffectType): Affect[] {
  const out: Affect[] = [];
  for (const affect of affects) if (affect.type === type) out.push(affect);
  return out;
}

/**
 * The total modifier at one location — the numeric half of the fold.
 *
 * Summed, with no cap and no arbitration here: what a total *means* is the deriving module's business
 * (`vitals.ts` puts a soft curve on regeneration, because Duris does), and burying a rule in the
 * accumulator would hide it from the place it has to be read.
 */
export function sumApply(affects: Iterable<Affect>, apply: ApplyLocation): number {
  let total = 0;
  for (const affect of affects) if (affect.apply === apply) total += affect.modifier;
  return total;
}

/**
 * Every affect at one location — the non-numeric half of the fold.
 *
 * For a stat that is not a sum. Light is the one we have: the answer is the *best* candidate, and
 * adding two torches together would be nonsense rather than a bright light. Phase 16 turns equipped
 * items into further candidates, which is why the derivation takes a list today when the list is
 * never longer than one.
 */
export function affectsFor(affects: Iterable<Affect>, apply: ApplyLocation): Affect[] {
  const out: Affect[] = [];
  for (const affect of affects) if (affect.apply === apply) out.push(affect);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Adding, removing, expiring                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How a second instance of something already running is resolved.
 *
 * **Stacking is per-mechanic policy, not a system rule** — `REFERENCE-mud-mechanics.md` §3.5, and
 * Duris has all three idioms live at once: sanctuary tests the bit and bails, armor walks the list
 * overwriting `duration`, and `affect_join` sums both duration and modifier. Picking one and calling
 * it *the* rule would make two thirds of a spell list unimplementable, so the caller says which it
 * means.
 */
export type StackPolicy =
  /** Refuse: something of this type is already running and wins. */
  | 'keep'
  /** Replace every node of this type with the new one. Duris' armor. */
  | 'replace'
  /** Sum durations and modifiers node-for-node. Duris' `affect_join`. */
  | 'join';

export interface AddResult {
  /** Whether the list changed. `false` only from `keep` against an incumbent. */
  readonly changed: boolean;
  /** Nodes taken off the list to make room, which `replace` and `join` both do. */
  readonly removed: readonly Affect[];
}

/**
 * Puts affects on a list under a stacking policy. Mutates, and says what it did.
 *
 * `join` matches on **type *and* location**, not on type alone. Duris' `affect_join` matches on type
 * and hits the first node it finds, which is fine there only because the spells that use it are
 * single-location; a multi-location affect joined by type alone would fold a hit-point bonus into a
 * mana one. Matching the pair is the same rule stated so it cannot go wrong.
 */
export function addAffects(list: Affect[], incoming: readonly Affect[], policy: StackPolicy = 'replace'): AddResult {
  if (incoming.length === 0) return { changed: false, removed: [] };

  const types = new Set(incoming.map((affect) => affect.type));

  if (policy === 'keep') {
    for (const type of types) if (hasType(list, type)) return { changed: false, removed: [] };
    list.push(...incoming);
    return { changed: true, removed: [] };
  }

  if (policy === 'join') {
    const removed: Affect[] = [];
    for (const affect of incoming) {
      const index = list.findIndex((held) => held.type === affect.type && held.apply === affect.apply);
      const held = index === -1 ? undefined : list[index];
      if (held && index !== -1) {
        list.splice(index, 1);
        removed.push(held);
        // Unlimited swallows anything joined into it: adding a minute to "for ever" is still for ever,
        // and the arithmetic would otherwise turn the sentinel into a real, very short duration.
        const durationMs =
          held.durationMs === UNLIMITED_DURATION || affect.durationMs === UNLIMITED_DURATION
            ? UNLIMITED_DURATION
            : held.durationMs + affect.durationMs;
        list.push({ ...affect, durationMs, modifier: held.modifier + affect.modifier });
      } else {
        list.push(affect);
      }
    }
    return { changed: true, removed };
  }

  const removed: Affect[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const held = list[i]!;
    if (!types.has(held.type)) continue;
    list.splice(i, 1);
    removed.push(held);
  }
  list.push(...incoming);
  return { changed: true, removed };
}

/**
 * Takes every node of a type off the list — the removal path, and therefore the dispel path.
 *
 * Removing *all* of them is the point, not a convenience. `affect_from_char(ch, skill)` does the
 * same, and it has to: a multi-location affect that dispelled one node at a time would leave a
 * character with two thirds of a buff and no way to name what was left (§4.12).
 */
export function removeType(list: Affect[], type: AffectType): Affect[] {
  const removed: Affect[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.type !== type) continue;
    removed.push(list[i]!);
    list.splice(i, 1);
  }
  // Reversed so callers see them in list order rather than in the order the reverse walk found them.
  return removed.reverse();
}

export interface AffectProgress {
  /** Nodes whose time ran out this step. Already off the list. */
  readonly expired: readonly Affect[];
  /** Nodes that crossed their warning threshold this step. Still on the list. */
  readonly expiring: readonly Affect[];
}

/**
 * Runs every duration down by one step, and reports what that did. Mutates the list.
 *
 * **The one expiry pass.** Duris walks its whole character list once per 75-second tick to do this
 * (`affect_update`, `affects.c:4176`); we do it on the 100 ms tick, which is the clock this project
 * says drives timers and — more usefully — is reproducible from a tick count in a test where a wall
 * clock is a source of flake.
 *
 * Expiry is `<= 0` rather than `< 0`: a duration that has reached exactly zero has no time left, and
 * treating zero as one more step alive would give every affect in the game a free tick and make the
 * arithmetic in the tests off by one for ever.
 */
export function advanceAffects(list: Affect[], elapsedMs: number): AffectProgress {
  const expired: Affect[] = [];
  const expiring: Affect[] = [];

  for (let i = list.length - 1; i >= 0; i--) {
    const affect = list[i]!;
    if (affect.durationMs === UNLIMITED_DURATION) continue;

    const left = affect.durationMs - elapsedMs;
    if (left <= 0) {
      affect.durationMs = 0;
      list.splice(i, 1);
      expired.push(affect);
      continue;
    }

    affect.durationMs = left;
    const warnAt = affectKind(affect.type)?.warnAtMs;
    if (warnAt !== undefined && !affect.warned && left <= warnAt) {
      affect.warned = true;
      expiring.push(affect);
    }
  }

  // Both reversed for the same reason `removeType` reverses: the walk runs backwards so that
  // splicing cannot skip an entry, and a caller reading the events should see list order.
  return { expired: expired.reverse(), expiring: expiring.reverse() };
}

/* -------------------------------------------------------------------------- */
/* Display                                                                     */
/* -------------------------------------------------------------------------- */

export interface AffectSummary {
  readonly type: AffectType;
  readonly name: string;
  /** Milliseconds left, or `undefined` for one that never expires. */
  readonly remainingMs: number | undefined;
}

/**
 * What to show, one row per *cause* rather than one per node — the display path.
 *
 * Two things it does, and both are consequences of `type` not being a key:
 *
 * - **It groups.** `second_wind` is three nodes and is one thing that happened to you; three
 *   identical rows counting down together would be a leak of the implementation into the HUD. Duris
 *   has the same problem in `score` and solves it the same way, by skipping runs of identical types.
 * - **It keeps the longest remaining** of a group. Nodes of one cause are installed together and so
 *   normally agree, but `join` can leave them differing, and the answer a player wants to the
 *   question "how long have I got" is the last moment any of it is still true.
 *
 * `NoShow` nodes are dropped here rather than at each caller, so the HUD and the `affects` command
 * cannot disagree about what is hidden.
 */
export function summariseAffects(affects: Iterable<Affect>): AffectSummary[] {
  const order: AffectType[] = [];
  const longest = new Map<AffectType, number | undefined>();

  for (const affect of affects) {
    if (hasFlag(affect, AffectFlag.NoShow)) continue;
    const kind = affectKind(affect.type);
    if (!kind) continue;

    const remaining = affect.durationMs === UNLIMITED_DURATION ? undefined : affect.durationMs;
    if (!longest.has(affect.type)) {
      order.push(affect.type);
      longest.set(affect.type, remaining);
      continue;
    }
    const held = longest.get(affect.type);
    // `undefined` is unlimited, which outlasts every number there is.
    if (held === undefined) continue;
    if (remaining === undefined || remaining > held) longest.set(affect.type, remaining);
  }

  return order.map((type) => ({
    type,
    name: AFFECT_TYPES[type].name,
    remainingMs: longest.get(type),
  }));
}
