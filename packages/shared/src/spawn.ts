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
   * Duris' **race code** — the fourth column of `race_names_table` in `common.c`, a short string like
   * `H` or `PT`. V7.
   *
   * Read since the harvest landed and thrown away: `spriteFor` used it to choose a body and kept nothing.
   * Its reader now is `attackTypeForRace` in `attacks.ts` — an unarmed creature's blow is a function of
   * its race in the source (`GetFormType`), which is how a spider stings and a troll mauls, and it is not
   * a field any builder authored.
   *
   * **It will have a second reader at Phase 21**, where aggression predicates and the racewar both need
   * it — the handoff notes that `all` is the only evaluable aggro clause *"until races and alignment
   * exist"*. Kept as the source's own code rather than anything derived from it for that reason.
   *
   * **Optional, because the spawn files are a worldgen output and a checkout may hold an older one.**
   * Absent means the source's own `default`, which is `MSG_HIT` — the creature punches. That is the same
   * treatment `maxHp`, `equipped` and every other later-arriving field gets, and it is what stops a stale
   * `data/world` from being a crash instead of a rebuild.
   */
  readonly race?: string;
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
   * What killing it is worth in coin, in all four currencies. Phase 15c.
   *
   * **Awarded on death rather than looted** — owner's call (2026-08-03): *"maybe we can just have the
   * coins awarded when a mob is killed… then we can skip the looting currency altogether."* It is the
   * right simplification for the same reason experience works that way: coin is not a *thing*, it is a
   * number, and making a player walk to a body to collect a number is ceremony without a decision in
   * it. Duris keeps it on the mob record for exactly this reason — right beside the experience, on the
   * same line of the same file.
   *
   * Absent for the many mobs the file gives nothing.
   */
  readonly coins?: Readonly<Partial<Record<'copper' | 'silver' | 'gold' | 'platinum', number>>>;
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
 * ## `arg3` is not a room, and assuming it was cost the whole loot table
 *
 * Every command line is `<letter> <if> <arg1> <arg2> <arg3> <arg4>`, and until 15c this type modelled
 * `arg3` as **the room** for every kind. `renum_zone` in `db.c` says otherwise, per letter:
 *
 * | | `arg1` | `arg3` |
 * | --- | --- | --- |
 * | `M` `F` `R` | mobile | room |
 * | `O` | object | room |
 * | `D` | *room* (`arg1`!) | door state |
 * | `G` | object | **nothing** |
 * | `E` | object | **wear position** |
 * | `P` | object | **the container's object vnum** |
 *
 * The harvest looked `arg3` up in the room map and dropped the command when it missed, so across the
 * shipped world **all 10,409 `G` and all 16,263 `E` commands vanished silently**, and of 8,858 `P`
 * commands the 172 that survived did so by *coincidence* — a container vnum that happened to collide
 * with a room vnum — carrying a `room` that pointed somewhere unrelated. Exactly `CLAUDE.md` gotcha 1:
 * a mis-mapped field produces output that looks entirely plausible. Hence the per-kind fields below,
 * and `room` being optional rather than a number that is sometimes a lie.
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
  /**
   * Where it goes. Already **our** room id, translated through the name join.
   *
   * **Absent for `give`, `equip` and `put`**, which place a thing on the last mobile loaded or inside
   * another object rather than in a room. See the table above.
   */
  readonly room?: RoomId;
  /**
   * `equip` only: Duris' wear position, **raw**.
   *
   * Deliberately not translated to an `EquipSlot` here, unlike rooms. A room id is a *join key* between
   * data sources and has to be reconciled at harvest; a wear position is a *rules* concept, and our slot
   * set is a fraction of Duris' 42 positions. Translating early would bake today's slots into the
   * harvested files, so adding a `waist` slot later would need a re-harvest to make old data reachable.
   * The mapping lives with the equipment model instead. `PRIMARY_WEAPON` is 16 — the most common value
   * in the world by a distance.
   */
  readonly wearPosition?: number;
  /** `put` only: the **object vnum of the container** this goes into. Never a room. */
  readonly container?: number;
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

/**
 * Reset letters that now have an executor, for the boot report to count.
 *
 * `isExecutable` is the *fall-through* gate inside `runReset` — the kinds handled after the early
 * returns — and it is deliberately not this list. `give`, `equip`, `object` and `put` are each handled
 * and then `continue`, so they never reach it. Two names because they answer two questions, and
 * collapsing them is how a report starts claiming a letter is unimplemented while it is running.
 */
export const IMPLEMENTED_RESET_KINDS: readonly ResetCommand['kind'][] = [
  'mob',
  'door',
  'give',
  'equip',
  'object',
  'put',
];
