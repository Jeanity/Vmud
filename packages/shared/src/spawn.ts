/**
 * Mob templates and zone reset tables — the shape worldgen writes and the server reads.
 *
 * In `shared` for the same reason `Zone` and `Room` are: worldgen produces it offline and the server
 * consumes it at play time, so the two must agree about the bytes on disk. None of this is on the wire —
 * a client is told about *instances* through `EntityView` and never about a template.
 *
 * ## Reset is additive. Nothing here despawns anything.
 *
 * `REFERENCE-mud-mechanics.md` §4.9 is the whole design note and it is a warning: zone reset in Duris
 * **only loads**. Population converges because per-vnum instance limits block over-spawning, not because
 * anything is cleared away. Write a despawn pass and the game changes profoundly — a mob lured three
 * zones away is *supposed* to still be alive, still counting against its limit, and still walking home.
 *
 * So a reset is not "restore the authored state". It is "top the world up to the limits", and the
 * difference is the entire mechanic.
 */

import type { AggroRule } from './aggression.ts';
import type { CombatStats } from './combat.ts';
import type { PursuitRule } from './pursuit.ts';
import type { RoomId, ZoneId } from './world.ts';

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What one kind of creature is.
 *
 * Deliberately thin, and it grew by exactly one field in Phase 9. Duris' `.mob` record also carries five
 * `affected_by` words, saving throws, class, gold and experience — and none of *that* has a consumer, so
 * none of it is harvested. Loot and experience are Phase 13. Re-running the harvest is free and offline, so
 * a field costs nothing to add later and costs the inert surface `ROADMAP.md` rule 1 warns about if added
 * now.
 */
export interface MobTemplate {
  /**
   * The MUD's own mob vnum. **The instance limit is keyed on this**, so it has to be the real number and
   * never a renumbering of ours — the same rule room and zone ids follow.
   */
  readonly vnum: number;
  /** Words this answers to, for `kill 2.guard`. Authored upstream, so no derivation is needed. */
  readonly keywords: readonly string[];
  /** How it is referred to in a sentence: "a sentry", "Masha the dicer". */
  readonly name: string;
  /**
   * How it reads standing in a room: *"A snooty merchant's wife is here admiring the decor."*
   *
   * A whole sentence, not a fragment, because that is what Diku's `long_descr` is and what makes a
   * populated room read like a MUD rather than like a list of names.
   */
  readonly room: string;
  readonly level: number;
  /**
   * Hit points as **dice**, rolled per instance rather than fixed.
   *
   * Duris rolls `dice(n, size) + bonus` at spawn, so two guards of the same vnum are not equally tough.
   * Keeping the expression rather than a precomputed maximum preserves that, and it costs one seeded roll
   * — which `rules.ts` already has, and which must be seeded so a restart produces the same world.
   */
  readonly hp: string;
  /** Art key. See `Actor.sprite`; the client owns which layers that is. */
  readonly sprite: string;
  /**
   * Who this objects to and how quickly it works it out — Duris' `ACT_*` and three aggression words,
   * reduced to what has a reader. See `aggression.ts`, which is where the reasoning lives.
   */
  readonly aggro: AggroRule;
  /**
   * Whether it follows you out of the room, how far, and what turns it back. See `pursuit.ts`.
   *
   * Separate from {@link aggro} even though both come out of the same `ACT_*` word, because they answer
   * different questions and one is not a refinement of the other: a passive mob can be a leashed hunter
   * that never starts anything, and an aggressive one can be nailed to its floor.
   */
  readonly pursuit: PursuitRule;
  /**
   * What it fights with, and what it takes to hit it. See `combat.ts` — two of the three `.mob` combat
   * columns are trustworthy and the third is a lie the source itself ignores.
   */
  readonly combat: CombatStats;
  /**
   * What killing this is worth, straight from the `.mob` record's own field.
   *
   * Harvested rather than derived because the file has a real curve in it — 1,036 for a level 15 castle
   * servant against 243,000 for Malice — and any formula we invented would flatten twenty-five years of
   * a builder's tuning into `level * something`.
   */
  readonly experience: number;
  /**
   * The hit points below which this breaks off and runs — `ACT_WIMPY`, resolved to a number.
   *
   * **0 is a mob that never runs**, which is most of them. Stored as an absolute rather than as a
   * fraction of its roll: that is the source's rule (`level * 6`) and the right one here for a reason of
   * ours — {@link MobTemplate.hp} is dice, so two guards of one vnum have different maxima and a fraction
   * would break them at different wounds. See `morale.ts`.
   */
  readonly wimpyAt: number;
}

/* -------------------------------------------------------------------------- */
/* Reset tables                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One reset command, with rooms already translated to **our** ids by worldgen.
 *
 * Only `M` (load a mobile) and `D` (set a door) have executors — those are the two mechanics that exist.
 * The object commands are parsed and kept all the same, and that is not idle completeness: `G`, `E` and
 * `P` attach to *the last mobile loaded*, so an executor that had never been told they were there would
 * lose the cursor position and mis-attach the first item Phase 15 turns on. Keeping them means Phase 15
 * adds a branch rather than re-reading the file.
 */
export type ResetKind = 'mob' | 'door' | 'object' | 'give' | 'equip' | 'put' | 'follower' | 'mount';

export interface ResetCommand {
  readonly kind: ResetKind;
  /**
   * Chained to the previous command's success — Diku's `if_flag`.
   *
   * The cursor this implies is the source of most zone-file authoring bugs, so it is **explicit** here
   * rather than implicit in the executor's local state, as §4.9's note asks.
   */
  readonly ifPrevious: boolean;
  /** Mob vnum for `mob`/`follower`/`mount`; object vnum for the object commands. */
  readonly what: number;
  /**
   * Global instance limit for this vnum — Duris' `arg2`.
   *
   * **Global, not per zone**: `mob_index[].number` is a world-wide count, so a mob of this vnum standing
   * anywhere at all counts against it. That is what makes a lured mob suppress its own replacement.
   */
  readonly limit: number;
  /** Where it goes. Already **our** room id, translated through the name join. */
  readonly room: RoomId;
  /**
   * Percentage chance — Duris' `arg4`.
   *
   * Load-bearing and counter-intuitive: on a normal timed repop an `M` fires **only** when this is
   * exactly 100. Anything less never fires unless the reset is forced, which is why mob spawns are
   * deterministic in practice and *equipment* is the random layer. Measured across both matched zones:
   * every one of the 332 `M` commands is at 100, so the randomness really is all in the loot.
   */
  readonly percent: number;
  /** `door` only: which direction, and the state to set. */
  readonly direction?: string;
  readonly doorState?: 'open' | 'closed' | 'locked';
}

/**
 * A zone's population data, as one file.
 *
 * `lifespanMin`/`Max` are in **MUD ticks of 75 seconds**, straight from the `.zon` header, and the
 * lifespan is **re-rolled from the band after every reset** — which is the whole reason repop never
 * happens on a timetable you can set a watch by.
 */
export interface ZoneSpawns {
  readonly zone: ZoneId;
  /** Which `.zon`/`.mob` pair this came from, for the boot log and for tracing a bad row. */
  readonly source: string;
  readonly lifespanMin: number;
  readonly lifespanMax: number;
  readonly templates: readonly MobTemplate[];
  readonly resets: readonly ResetCommand[];
}

/** One MUD tick, in milliseconds — the clock a zone's age is counted in. `PULSES_IN_TICK` at 75 s. */
export const ZONE_TICK_MS = 75_000;

/**
 * Which of a zone's reset commands the server can currently act on.
 *
 * A named predicate rather than an inline test, so "what is not implemented yet" is one list that the
 * boot report and the executor read together and cannot disagree about.
 */
export function isExecutable(command: ResetCommand): boolean {
  return command.kind === 'mob' || command.kind === 'door';
}
