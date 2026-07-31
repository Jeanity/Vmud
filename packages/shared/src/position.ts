/**
 * Posture and status — two orthogonal axes, and the gate every action passes.
 *
 * ## Why two axes and not one ladder
 *
 * Stock Diku has a single `POSITION_*` ladder — dead, sleeping, resting, sitting, fighting, standing —
 * and every clone copies it. Duris does not: it packs **two independent fields into one byte**, and
 * that is the design worth copying.
 *
 * - **Posture** is how the body is arranged: prone, sitting, kneeling, standing.
 * - **Status** is how conscious it is: dead, dying, incapacitated, sleeping, resting, normal.
 *
 * Collapse them into one enum — the natural modern instinct — and a set of perfectly ordinary states
 * stop being expressible: *prone while fighting*, *standing while bleeding out*, *kneeling and
 * resting*. The MUD source proves it means this: `do_sleep` is
 * `SET_POS(ch, GET_POS(ch) + STAT_SLEEPING)`, which **keeps the posture** — you really can fall asleep
 * on your feet, and the room is told "$n has fallen asleep on $s feet, this should be fun."
 *
 * Note also what is *not* an axis here. Fighting is a pointer to an opponent, not a position, and
 * stunned is a timed effect. There is no `POSITION_FIGHTING`, deliberately, because engagement is a
 * relationship (see the engagement decision in `ROADMAP.md`) and consciousness is not.
 *
 * ## Both are ordered, and compared independently
 *
 * Duris stores status as single bits — `STAT_DEAD BIT_3` through `STAT_NORMAL BIT_8` — and then
 * compares them with `>=`, so the bit *magnitudes* form an ordinal scale. `MIN_POS` is
 * `GET_POS(ch) >= (v & 3) && GET_STAT(ch) >= (v & STAT_MASK)`: each half against its own minimum. We
 * keep the ordering and drop the bit-packing, which bought Duris one byte per character and buys us
 * nothing but a chance to get a mask wrong.
 *
 * The array order below **is** the ladder, the same trick the command table uses.
 */

/* -------------------------------------------------------------------------- */
/* The axes                                                                    */
/* -------------------------------------------------------------------------- */

/** How the body is arranged, least capable first. */
export const POSTURES = ['prone', 'sitting', 'kneeling', 'standing'] as const;

export type Posture = (typeof POSTURES)[number];

/** How conscious it is, least capable first. */
export const STATUSES = ['dead', 'dying', 'incapacitated', 'sleeping', 'resting', 'normal'] as const;

export type Status = (typeof STATUSES)[number];

const POSTURE_RANK: Readonly<Record<Posture, number>> = Object.freeze(
  Object.fromEntries(POSTURES.map((p, i) => [p, i])) as Record<Posture, number>,
);

const STATUS_RANK: Readonly<Record<Status, number>> = Object.freeze(
  Object.fromEntries(STATUSES.map((s, i) => [s, i])) as Record<Status, number>,
);

export function postureRank(posture: Posture): number {
  return POSTURE_RANK[posture];
}

export function statusRank(status: Status): number {
  return STATUS_RANK[status];
}

/** Where a character is on both axes. */
export interface Stance {
  readonly posture: Posture;
  readonly status: Status;
}

/**
 * The minimum a command needs on each axis, independently.
 *
 * Duris writes these as a sum in the command table — `CMD_HIT` is `STAT_NORMAL + POS_STANDING`,
 * `CMD_WAKE` is `STAT_SLEEPING + POS_PRONE` — which works only because the two halves live in
 * different bits of one byte. Spelled out as two fields it says the same thing and cannot be
 * misadded.
 */
export interface Requirement {
  readonly posture: Posture;
  readonly status: Status;
  /**
   * Whether this command may be used while fighting.
   *
   * **A third independent gate, not a consequence of the other two** — Duris carries it as a separate
   * boolean per command (`CMD_Y` / `CMD_N`) alongside the two-axis position minimum, and
   * `DESIGN-engagement.md` §6 transcribes the rows rather than guessing them. The proof that it is
   * genuinely independent is in the table: `sit`, `kneel` and `stand` are all allowed mid-fight while
   * `rest` and `sleep` are not, so the gate lands on one axis and not the other. A single collapsed
   * position enum could not express that, which is Phase 4's two axes earning their keep a second time.
   *
   * Defaults to allowed when absent, because most commands are.
   */
  readonly inCombat?: boolean;
}

/** `MIN_POS`: both halves at or above their minimum. Neither can excuse the other. */
export function meets(stance: Stance, need: Requirement): boolean {
  return (
    postureRank(stance.posture) >= postureRank(need.posture) &&
    statusRank(stance.status) >= statusRank(need.status)
  );
}

/** Which axis is the problem, for a message that says something useful. */
export function shortfall(stance: Stance, need: Requirement): 'posture' | 'status' | undefined {
  // Status first: being unconscious is the more fundamental complaint, and telling someone to stand
  // up while they are asleep is not help.
  if (statusRank(stance.status) < statusRank(need.status)) return 'status';
  if (postureRank(stance.posture) < postureRank(need.posture)) return 'posture';
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Status from damage                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Hit-point thresholds for the dying window, from `calculate_ch_state` in `fight.c`.
 *
 * **Absolute, not proportional**, and deliberately kept that way. It means the window between "down"
 * and "gone" is a fixed seven points wide for a level 1 character and a level 50 one, so a rescue is
 * always the same number of points of healing away. Scaling it with `maxHp` would make high-level
 * death a long slow slide and low-level death instantaneous, which is the opposite of what the
 * mechanic is for.
 */
export const HP_DEAD_BELOW = -10;
export const HP_DYING_AT_OR_BELOW = -6;
export const HP_INCAPACITATED_AT_OR_BELOW = -3;

/**
 * The status a character should now be in.
 *
 * **Not a pure function of hit points**, though it is often described as one. It is a transition:
 * where you end up depends on where you were and on whether you are in a fight.
 *
 * - Below the thresholds, damage decides and nothing else matters.
 * - Above them, **a fight wakes you** — `sleeping` or `resting` becomes `normal` the moment someone
 *   swings at you, which is what stops resting being a way to opt out of being attacked.
 * - Otherwise, coming *back* from the floor lands you at `resting`, never straight at `normal`. You
 *   regain consciousness lying there, and standing up is a separate act.
 * - And a status the player chose — `sleeping`, `resting` — is left alone. Recomputing it to `normal`
 *   every tick is the obvious bug here: it would make `sleep` a command that appears to work and
 *   silently undoes itself.
 */
export function statusFor(hp: number, current: Status, fighting: boolean): Status {
  if (hp < HP_DEAD_BELOW) return 'dead';
  if (hp <= HP_DYING_AT_OR_BELOW) return 'dying';
  if (hp <= HP_INCAPACITATED_AT_OR_BELOW) return 'incapacitated';
  if (fighting && (current === 'sleeping' || current === 'resting')) return 'normal';
  // Was on the floor and is no longer: you come round resting.
  if (statusRank(current) < statusRank('sleeping')) return 'resting';
  return current;
}

/** Whether a character is conscious enough to act at all. */
export function isConscious(status: Status): boolean {
  return statusRank(status) >= statusRank('resting');
}

/* -------------------------------------------------------------------------- */
/* Prose                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How a stance reads in a room description — "is standing here", "is sleeping on the floor".
 *
 * Status wins when it is the remarkable half: nobody describes a dying man by his posture. Below
 * `resting` the posture is still carried, because "asleep on his feet" is exactly the sort of detail
 * the two-axis model exists to be able to say.
 */
export function describeStance(stance: Stance): string {
  const { posture, status } = stance;
  switch (status) {
    case 'dead':
      return 'is dead';
    case 'dying':
      return 'is bleeding to death';
    case 'incapacitated':
      return 'is lying here, unable to move';
    case 'sleeping':
      return posture === 'standing' ? 'is asleep on their feet' : `is asleep, ${POSTURE_PROSE[posture]}`;
    case 'resting':
      return `is resting, ${POSTURE_PROSE[posture]}`;
    case 'normal':
      return `is ${POSTURE_PROSE[posture]}`;
  }
}

const POSTURE_PROSE: Readonly<Record<Posture, string>> = {
  prone: 'lying on the floor',
  sitting: 'sitting down',
  kneeling: 'kneeling',
  standing: 'standing here',
};
