/**
 * Harvesting population: Duris `.mob` templates and `.zon` reset tables.
 *
 * The third stage of the same idea `duris.ts` runs for terrain and prose. Same two-file join, same
 * caveat, and one new problem that is the whole difficulty of this module:
 *
 * ## Reset tables name rooms by *Duris* vnum, and our ids are different
 *
 * Phase 3 established that Toril and Duris renumbered independently after the 1995 split, so the room
 * join is by **name**. That is fine for terrain, where the answer lands on the room we already have. A
 * reset command says *"load mob 97052 into room 97002"*, and 97002 is a number in a numbering we do not
 * use — so before a reset table can be executed at all, every vnum in it has to be resolved to one of
 * our room ids.
 *
 * The name join gives us the pairs. What it does not give us is uniqueness: **116 of IceCrag's 216
 * joinable rooms share a name with at least one other**, because "A Corner In the Ice Garden" exists
 * four times. Picking one arbitrarily would cluster four mobs into one corner and leave three empty.
 *
 * **So duplicated names are paired positionally**, and the evidence that this is sound rather than
 * convenient is measured: of the 37 duplicated names in IceCrag, **37 have exactly the same count on
 * both sides**. Duris has four Ice Garden corners and so do we. Sorting each side and zipping them
 * therefore puts one mob in each corner, which is faithful *as a distribution* even where it cannot be
 * faithful about which corner is which — and for population that is the property that matters. Where the
 * counts disagree (two names in Kobold Settlement, both Duris having more) the surplus simply does not
 * resolve and its commands are dropped and counted.
 *
 * ## What is deliberately not harvested
 *
 * Behaviour: the five `affected_by` words, three aggression bitfields, class, alignment, gold and
 * experience. All of it is in the file and none of it has a consumer — aggression is Phase 9, loot and
 * experience Phase 13. The harvest is offline and free to re-run, so a field costs nothing to add later
 * and costs the inert surface `ROADMAP.md` rule 1 warns about if added now.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  huntRule,
  readCombatStats,
  reactionFor,
  type AggroClause,
  type AggroRule,
  type PursuitRule,
  type MobTemplate,
  type ResetCommand,
  type ResetKind,
  type RoomId,
  type Zone,
  type ZoneSpawns,
} from '@mygame/shared';

import { normaliseName, stripColour, type DurisRoom } from './duris.ts';

/* -------------------------------------------------------------------------- */
/* Races, and what we can draw                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Duris race codes we have a body for, and the art key each maps to.
 *
 * The codes are the fourth column of `race_names_table` in `common.c`. Only humanoids are here, and that
 * is the honest limit of the LPC set on disk: the base bodies are Human (several), Orc and Skeleton, and
 * nothing else. A mob whose race is not in this table is **not spawned** — see {@link spriteFor}.
 *
 * `G` (Giant) maps to the human body knowingly. A giant *is* a humanoid and only its scale is wrong,
 * which is a different order of error from drawing a coyote as a man; `EntityView` carries no scale, so
 * the alternative was to omit six mobs over a detail nothing in the game reads yet.
 */
const HUMANOID_RACES: Readonly<Record<string, string>> = {
  H: 'human', // Humanoid — the bulk of any castle roster
  PH: 'human', // Human
  PB: 'human', // Barbarian
  PL: 'human', // Drow Elf
  PE: 'human', // Grey Elf
  PM: 'human', // Mountain Dwarf
  PD: 'human', // Duergar
  PF: 'human', // Halfling
  PG: 'human', // Gnome
  P2: 'human', // Half-Elf
  PO: 'human', // Ogre
  PT: 'human', // Troll
  G: 'human', // Giant — see above
};

/**
 * The art key for a race code, or nothing if we cannot draw it honestly.
 *
 * Returning nothing is a real answer and the caller must respect it: the alternative is a chicken shaped
 * like a person, which is the sort of placeholder that stops being noticed and ships. The owner's rule
 * for Kobold Settlement was exactly this, applied per zone; this is the same rule applied per template.
 */
export function spriteFor(raceCode: string): string | undefined {
  return HUMANOID_RACES[raceCode.toUpperCase()];
}

/* -------------------------------------------------------------------------- */
/* Behaviour flags                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The `ACT_*` bits we read, by bit number. `BIT_n` in `defines.h` is `1 << (n - 1)`.
 *
 * Six of thirty-two, and each has a reader: memory and sentinel for Phase 9's aggression, hunter,
 * stay-zone and sentinel again for Phase 10's pursuit, wimpy for Phase 14's morale. The other
 * twenty-seven — breath weapons, scavenging, teacher, elite — are real and unread, and the harvest is
 * offline so they cost nothing to add when something wants them.
 *
 * **`ACT_SENTINEL` is read by both and means different things to each**, which is §4.11's warning made
 * concrete: to aggression it is "does not wander", to pursuit it is *"will not leave its zone to hunt"* —
 * the source's own `if ((SENTINEL || STAY_ZONE) && zone differs) return`. It is emphatically not
 * "immobile", and a reader who assumes it is will write a sentinel that refuses to chase anyone.
 */
const ACT_SENTINEL = 1 << 1;
const ACT_STAY_ZONE = 1 << 6;
const ACT_WIMPY = 1 << 7;
const ACT_MEMORY = 1 << 11;
const ACT_PROTECTOR = 1 << 26;
const ACT_HUNTER = 1 << 30;

/** `specials.act2`, a second word. One bit read: `ACT2_NO_LURE` opts a mob out of hunting entirely. */
const ACT2_NO_LURE = 1 << 1;

/**
 * The `AGGR_*` bits we read, by bit number, from the **first** aggression word.
 *
 * Duris has three words and twenty-five clauses; these six are the ones the loaded zones actually use.
 * Measured: IceCrag uses `ALL` alone (14 of 66 mobs), Kobold Settlement adds `GOOD_RACE`, `GOOD_ALIGN` and
 * `NEUTRAL_ALIGN`. So the set is drawn from the data rather than from the header file.
 *
 * The second and third words are still consulted — for whether a mob is aggressive *at all* — because
 * `IS_AGGRESSIVE` is "any word non-zero", and a mob whose only bits live in word two would otherwise read as
 * passive. Its clauses are unknown to us, which {@link matchesAggro} correctly refuses.
 */
const AGGR_BITS: readonly (readonly [bit: number, clause: AggroClause])[] = [
  [1, 'all'],
  [4, 'goodAlign'],
  [5, 'neutralAlign'],
  [6, 'evilAlign'],
  [7, 'goodRace'],
  [8, 'evilRace'],
];

/**
 * Reads a mob's disposition and predicate out of its flag words.
 *
 * `aggressive` is `IS_AGGRESSIVE`'s own rule — **any** of the three words non-zero — rather than "word one
 * has bits we recognise". The distinction matters: reading only word one would silently pacify a mob whose
 * author put its clauses in word two, and it would look like a builder's mistake rather than ours.
 *
 * Nothing here ever returns `territorial`. No `.mob` bit means it — it is the design's own invention
 * (§2.3) — so it stays a value the type admits and the harvest never produces.
 */
export function readAggro(act: number, words: readonly number[], level: number): AggroRule {
  const aggressive = words.some((word) => word !== 0);
  const first = words[0] ?? 0;
  const clauses: AggroClause[] = [];
  for (const [bit, clause] of AGGR_BITS) {
    if (first & (1 << (bit - 1))) clauses.push(clause);
  }
  return {
    disposition: aggressive ? 'aggressive' : 'passive',
    clauses,
    reactionMs: reactionFor(level),
    remembers: (act & ACT_MEMORY) !== 0,
    sentinel: (act & ACT_SENTINEL) !== 0,
    assists: (act & ACT_PROTECTOR) !== 0,
  };
}

/** Whether a mob flees when hurt — Duris' `ACT_WIMPY`. Harvested nowhere yet; Phase 14 wants it. */
export function isWimpy(act: number): boolean {
  return (act & ACT_WIMPY) !== 0;
}

/**
 * Reads how a mob gives chase out of the same `ACT_*` word.
 *
 * **`ACT_MEMORY` is passed through deliberately.** §4.11: the entire hunt branch in `mobact.c` sits inside
 * `if (IS_SET(act, ACT_MEMORY))`, so `ACT_HUNTER` alone produces a mob that looks configured and is inert.
 * Reading the two bits independently and letting {@link huntRule} combine them keeps that dependency in one
 * place instead of spread across a harvest and a runtime.
 *
 * `opensDoors` is `true` for everything this harvest produces, and that is a consequence rather than a
 * decision: the source's rule is *"animals don't open doors"* — `!CAN_SPEAK && !IS_GREATER_RACE` — and
 * {@link spriteFor} already drops every non-humanoid race for want of a body to draw. So the day there is
 * creature art is the day this can return `false`, and the field exists so that day changes one line.
 */
export function readPursuit(act: number, act2 = 0): PursuitRule {
  return huntRule({
    hunter: (act & ACT_HUNTER) !== 0,
    remembers: (act & ACT_MEMORY) !== 0,
    sentinel: (act & ACT_SENTINEL) !== 0,
    staysInZone: (act & ACT_STAY_ZONE) !== 0,
    // Always 0 from a simple record and the parameter is still here on purpose. The `S` header is
    // `<act> <aggro×3> <affected×4> <alignment> <type>` — there is **no second action word in it**, so
    // `ACT2_NO_LURE` cannot be read from the zones we load. Defaulting it inside the parser rather than
    // dropping the argument keeps the bit named and its absence explained, so an `E`-type parser can pass
    // the real word without anyone rediscovering which bit meant what.
    noLure: (act2 & ACT2_NO_LURE) !== 0,
    opensDoors: true,
  });
}

/* -------------------------------------------------------------------------- */
/* .mob                                                                        */
/* -------------------------------------------------------------------------- */

/** A template plus the reason it was rejected, so the report can say what it lost and why. */
export interface MobHarvest {
  readonly templates: readonly MobTemplate[];
  /** Rejected templates: vnum, name and cause. */
  readonly skipped: readonly { readonly vnum: number; readonly name: string; readonly why: string }[];
}

/**
 * Parses one `.mob` file.
 *
 * Record layout, classic Diku — four tilde-terminated strings then a numeric block:
 *
 * ```
 * #<vnum>
 * <keywords>~
 * <short description>~      "a sentry"        — how it reads in a sentence
 * <long description>~       "A sentry stands watch here."  — how it reads in a room
 * <detailed description>~   what `look sentry` would print
 * <act> <aggro...> <affected...> <alignment> <type letter>
 * <race code> <home> <class> <size>
 * <level> <hitroll> <armour> <hp dice> <damage dice>
 * <coins> <exp>
 * <position> <default position> <sex>
 * ```
 *
 * Only the `S` (simple) type letter appears in the zones we load — all 66 of IceCrag's are `S` — so that
 * is the only numeric shape read. An `E`-type record would need its extra keyed lines and is refused
 * loudly rather than half-parsed into plausible nonsense.
 *
 * Split on a line that is exactly `#<digits>`, walked with a regex over the whole file rather than line
 * by line: unlike the `.wld` files these are small, and the tilde-delimited strings span lines freely.
 */
export function parseMobFile(path: string): MobHarvest {
  const raw = readFileSync(path, 'latin1');
  const templates: MobTemplate[] = [];
  const skipped: { vnum: number; name: string; why: string }[] = [];

  const parts = raw.split(/^#(\d+)[ \t]*$/m).slice(1);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const vnum = Number(parts[i]);
    const body = parts[i + 1] ?? '';

    // Four tilde-terminated strings, then everything after the fourth is numeric.
    const fields = body.split('~');
    if (fields.length < 5) {
      skipped.push({ vnum, name: '?', why: 'truncated record' });
      continue;
    }
    const keywords = stripColour(fields[0] ?? '').trim().split(/\s+/).filter(Boolean);
    const name = stripColour(fields[1] ?? '').replace(/\s+/g, ' ').trim();
    const room = stripColour(fields[2] ?? '').replace(/\s+/g, ' ').trim();

    const lines = (fields[4] ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    // `<act> <aggro1> <aggro2> <aggro3> <aff1..4> <alignment> <type>` in the ten-field form, and shorter
    // shapes for older records. The type letter is always last; the act word is always first; the three
    // aggression words only exist in the ten- and nine-field forms, which is why they are read by *length*
    // rather than by position. Reading them positionally in a shorter record would take an `affected_by`
    // word for an aggression one and make half a zone hostile.
    const header = lines[0]?.split(/\s+/) ?? [];
    const type = header[header.length - 1];
    const act = Number(header[0]) || 0;
    const aggroWords =
      header.length === 10
        ? [Number(header[1]) || 0, Number(header[2]) || 0, Number(header[3]) || 0]
        : header.length === 9
          ? [Number(header[1]) || 0, Number(header[2]) || 0]
          : [];
    if (type !== 'S') {
      skipped.push({ vnum, name, why: `type "${type ?? '?'}" is not the simple form` });
      continue;
    }

    // `<race> <home> <class> <size>` — the race code is a short string, not a number.
    const raceCode = lines[1]?.split(/\s+/)[0] ?? '';
    const sprite = spriteFor(raceCode);
    if (!sprite) {
      skipped.push({ vnum, name, why: `race "${raceCode}" has no body in the LPC set` });
      continue;
    }

    // `<level> <hitroll> <armour> <hp dice> <damage dice>`.
    //
    // **Column 1 is read and discarded, and that is deliberate.** `db.c` `fscanf`s the hitroll and then
    // overwrites it from level on the very next line, so the number in the file has been ignored since
    // 1995 — and taking it literally would be actively wrong, because IceCrag's is often negative on its
    // best fighters. Armour and damage are real. See `combat.ts`.
    const stats = lines[2]?.split(/\s+/) ?? [];
    const level = Number(stats[0]);
    const armour = Number(stats[2]);
    const hp = stats[3] ?? '';
    const damage = stats[4] ?? '';
    if (!Number.isFinite(level) || level < 1 || !/^\d+d\d+\+\d+$/.test(hp)) {
      skipped.push({ vnum, name, why: `unreadable level/hp ("${stats.slice(0, 4).join(' ')}")` });
      continue;
    }

    // `<coins> <experience>`. Coins are four dot-separated denominations and wait for Phase 17's money;
    // experience has a reader as of Phase 13, so it is taken and they are not. Measured on IceCrag: 1,036
    // for a level 15 servant up to 243,000 for Malice, which is a real curve rather than a derivation we
    // would otherwise have had to invent.
    const purse = lines[3]?.split(/\s+/) ?? [];
    const experience = Number(purse[1]);

    if (keywords.length === 0 || name.length === 0) {
      skipped.push({ vnum, name, why: 'no keywords or no name' });
      continue;
    }

    templates.push({
      vnum,
      keywords,
      name,
      room,
      level,
      hp,
      sprite,
      aggro: readAggro(act, aggroWords, level),
      pursuit: readPursuit(act),
      experience: Number.isFinite(experience) && experience > 0 ? experience : 0,
      combat: readCombatStats({
        level,
        armour: Number.isFinite(armour) ? armour : 0,
        damage,
      }),
    });
  }

  return { templates, skipped };
}

/* -------------------------------------------------------------------------- */
/* .zon                                                                        */
/* -------------------------------------------------------------------------- */

/** Diku's direction order in a `.zon` `D` command: `D0=N, D1=E, D2=S, D3=W, D4=U, D5=D`. */
const ZON_DIRECTIONS = ['north', 'east', 'south', 'west', 'up', 'down'] as const;

/** The letters, mapped to what they mean. Unknown letters are dropped and counted. */
const RESET_KINDS: Readonly<Record<string, ResetKind>> = {
  M: 'mob',
  O: 'object',
  G: 'give',
  E: 'equip',
  P: 'put',
  D: 'door',
  F: 'follower',
  R: 'mount',
};

export interface RawZoneFile {
  readonly vnum: number;
  readonly lifespanMin: number;
  readonly lifespanMax: number;
  /** Rooms still in **Duris** vnums. Translation happens in {@link buildZoneSpawns}. */
  readonly commands: readonly RawReset[];
}

export interface RawReset {
  readonly kind: ResetKind;
  readonly ifPrevious: boolean;
  readonly what: number;
  readonly limit: number;
  readonly durisRoom: number;
  readonly percent: number;
  readonly direction?: string;
  readonly doorState?: 'open' | 'closed' | 'locked';
}

/**
 * Parses one `.zon` file: the header band and the reset commands.
 *
 * Header, from `db.c`'s own `fscanf`:
 * `<top room> <reset mode> <flags> <lifespan min> <lifespan max> <difficulty>` — the two lifespans being
 * the band a fresh lifespan is re-rolled from after every reset, in 75-second MUD ticks.
 *
 * Command lines are `<letter> <if_flag> <arg1> <arg2> <arg3> <arg4> ...`. Lines beginning `*` are
 * comments and are frequent — the builder's own annotations of what each door joins — and `S` ends the
 * table.
 *
 * A `D` command's `arg2` is the direction and `arg3` the state: `& 3` gives open/closed/locked, with
 * `|4` secret and `|8` blocked. Only the low two bits are read, because secret and blocked doors have no
 * mechanic here — `Door` carries `closed` and `locked` and nothing else.
 */
export function parseZoneFile(path: string): RawZoneFile | undefined {
  const raw = readFileSync(path, 'latin1');
  const lines = raw.split(/\r?\n/);

  let vnum = -1;
  let header: number[] | undefined;
  const commands: RawReset[] = [];

  for (const line of lines) {
    const text = line.trim();
    if (!text || text.startsWith('*')) continue;

    if (vnum < 0 && text.startsWith('#')) {
      vnum = Number(text.slice(1));
      continue;
    }
    // The two tilde-terminated strings (zone name, filename) come next; skip them, then the first
    // all-numeric line is the header band.
    if (!header) {
      const fields = text.split(/\s+/).map(Number);
      if (fields.length >= 6 && fields.every((n) => Number.isFinite(n))) header = fields;
      continue;
    }

    if (text === 'S' || text.startsWith('S ')) break;

    const letter = text[0] ?? '';
    const kind = RESET_KINDS[letter];
    if (!kind) continue;

    const f = text.slice(1).trim().split(/\s+/).map(Number);
    const [ifFlag, arg1, arg2, arg3, arg4] = f;
    if (!Number.isFinite(arg1)) continue;

    if (kind === 'door') {
      // `D <if> <room> <dir> <state>` — the room is arg1 here, not arg3.
      const dir = ZON_DIRECTIONS[arg2 ?? -1];
      const state = (arg3 ?? 0) & 3;
      if (!dir) continue;
      commands.push({
        kind,
        ifPrevious: ifFlag === 1,
        what: 0,
        limit: 0,
        durisRoom: arg1 ?? 0,
        percent: arg4 ?? 100,
        direction: dir,
        doorState: state === 2 ? 'locked' : state === 1 ? 'closed' : 'open',
      });
      continue;
    }

    commands.push({
      kind,
      ifPrevious: ifFlag === 1,
      what: arg1 ?? 0,
      limit: arg2 ?? 0,
      durisRoom: arg3 ?? 0,
      percent: arg4 ?? 100,
    });
  }

  if (vnum < 0 || !header) return undefined;
  return {
    vnum,
    lifespanMin: header[3] ?? 30,
    lifespanMax: header[4] ?? 30,
    commands,
  };
}

/* -------------------------------------------------------------------------- */
/* The room mapping, and assembly                                              */
/* -------------------------------------------------------------------------- */

/**
 * Duris vnum → our room id, pairing duplicated names positionally.
 *
 * Both sides are sorted before zipping — Duris by vnum, ours by room id — so the mapping is a pure
 * function of the two files and identical on every run. Where one side has more rooms of a name than the
 * other, the surplus is left unmapped rather than doubled up or dropped at random.
 *
 * See this module's header for why positional pairing is defensible: it is faithful about the
 * *distribution* even where it cannot be about identity, and for placing population that is the property
 * that matters.
 */
export function buildRoomMap(zone: Zone, durisRooms: readonly DurisRoom[]): Map<number, RoomId> {
  const oursByKey = new Map<string, RoomId[]>();
  for (const room of zone.rooms) {
    const key = normaliseName(room.name);
    if (!key) continue;
    const bucket = oursByKey.get(key);
    if (bucket) bucket.push(room.id);
    else oursByKey.set(key, [room.id]);
  }
  for (const bucket of oursByKey.values()) bucket.sort((a, b) => a - b);

  const durisByKey = new Map<string, number[]>();
  for (const room of durisRooms) {
    if (!room.key) continue;
    const bucket = durisByKey.get(room.key);
    if (bucket) bucket.push(room.vnum);
    else durisByKey.set(room.key, [room.vnum]);
  }

  const out = new Map<number, RoomId>();
  for (const [key, vnums] of durisByKey) {
    const ours = oursByKey.get(key);
    if (!ours) continue;
    vnums.sort((a, b) => a - b);
    // Zip as far as the shorter side goes; the surplus stays unmapped.
    for (let i = 0; i < Math.min(vnums.length, ours.length); i++) {
      out.set(vnums[i]!, ours[i]!);
    }
  }
  return out;
}

export interface SpawnBuildStats {
  templates: number;
  templatesSkipped: number;
  commands: number;
  commandsDropped: number;
  /** Commands kept, by kind, so the report can say what has an executor and what is waiting. */
  byKind: Record<string, number>;
  roomsMapped: number;
}

/**
 * Assembles one zone's population file: templates, and reset commands with our room ids in them.
 *
 * A command whose room does not resolve is **dropped**, not guessed at. That loses about a third of them
 * — measured, 98 of IceCrag's 150 `M` commands resolve — and the alternative is worse: a mob placed in
 * an arbitrary room is content the source never authored, sitting somewhere no builder chose.
 *
 * A command naming a template we did not keep is dropped too, which is how the five IceCrag mobs with no
 * LPC body stay out of the world rather than turning up as men.
 */
export function buildZoneSpawns(
  zone: Zone,
  file: string,
  mobPath: string,
  zonPath: string,
  durisRooms: readonly DurisRoom[],
  stats: SpawnBuildStats,
): ZoneSpawns | undefined {
  const parsedZone = parseZoneFile(zonPath);
  if (!parsedZone) return undefined;

  const { templates, skipped } = parseMobFile(mobPath);
  const known = new Set(templates.map((t) => t.vnum));
  const rooms = buildRoomMap(zone, durisRooms);

  stats.templates += templates.length;
  stats.templatesSkipped += skipped.length;
  stats.roomsMapped += rooms.size;

  const resets: ResetCommand[] = [];
  for (const command of parsedZone.commands) {
    stats.commands++;
    const room = rooms.get(command.durisRoom);
    if (room === undefined) {
      stats.commandsDropped++;
      continue;
    }
    // A mob command for a template we did not keep would be a spawn with nothing to spawn.
    if ((command.kind === 'mob' || command.kind === 'follower' || command.kind === 'mount') && !known.has(command.what)) {
      stats.commandsDropped++;
      continue;
    }
    stats.byKind[command.kind] = (stats.byKind[command.kind] ?? 0) + 1;
    resets.push({
      kind: command.kind,
      ifPrevious: command.ifPrevious,
      what: command.what,
      limit: command.limit,
      room,
      percent: command.percent,
      ...(command.direction === undefined ? {} : { direction: command.direction }),
      ...(command.doorState === undefined ? {} : { doorState: command.doorState }),
    });
  }

  return {
    zone: zone.id,
    source: file,
    lifespanMin: parsedZone.lifespanMin,
    lifespanMax: parsedZone.lifespanMax,
    templates,
    resets,
  };
}

export function newSpawnStats(): SpawnBuildStats {
  return {
    templates: 0,
    templatesSkipped: 0,
    commands: 0,
    commandsDropped: 0,
    byKind: {},
    roomsMapped: 0,
  };
}

/** Where a zone's `.mob` and `.zon` files live, given the `.wld` filename the match resolved to. */
export function companionPaths(areasDir: string, wldFile: string): { mob: string; zon: string } {
  const stem = wldFile.replace(/\.wld$/i, '');
  return { mob: join(areasDir, 'mob', `${stem}.mob`), zon: join(areasDir, 'zon', `${stem}.zon`) };
}
