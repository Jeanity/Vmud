/**
 * The guilds' teaching — Phase 24, transcribed from `guild.c`'s `do_practice`.
 *
 * The source's machine: `FindTeacher` scans the room for any mob wearing `ACT_TEACHER`; what that
 * teacher may teach is implicit in the teacher's *own* class-and-level skill table
 * (`GET_LVL_FOR_SKILL(teacher, skl) <= GET_LEVEL(teacher)`), so a warriors' guildmaster cannot
 * teach backstab because no level of warrior ever has it. Ours keeps that shape with the table we
 * have: a trainer carries a **class**, and teaches exactly the skills `CLASS_SKILLS` grants that
 * class, to students whose own class can learn them.
 *
 * ## The cost curve is the source's, in our copper
 *
 * `SkillRaiseCost` (`guild.c:321`): `s = max(1, learned/10); cost = s² − 2s + 2; floor 10` — a
 * dozen coins at the bottom, sixty-five at mastery, in whatever unit the live game's property
 * scaled it to. Ours scales it **×100 into copper** (floor: ten silver), and the reason is this
 * week's own economy: keepers now pay scrap value, so a lucky sale is two gold — training is meant
 * to be the sink that coin disappears into, and at the source's raw numbers a master class would
 * cost less than a loaf. Mastering one skill from nothing runs to roughly twenty gold across the
 * curve, which is a goal, not an afternoon.
 *
 * ## The walls, in the source's order and its own words
 *
 * A practice is **+1 learned**, and it stops at: your purse ("Sorry, boss…"), twice your level
 * ("You have not fully grasped your previous lessons…" / "You will have to go learn more on your
 * own…" — the source's two sentences at `>` and `>=`, both kept), your class ceiling ("I'm sorry
 * but I can teach you no more."), and twice the *teacher's* level — at which the source rolls one
 * of four refusals that range from flattery to throwing you out of the hall, and all four are
 * transcribed because they are the best lines in the file.
 */

import { SKILL_IDS, ceilingFor, type ClassId, type SkillId } from '@mygame/shared';

/** The source's curve, ×100 into copper — see the header for why the scale is ours. */
export function practiceCost(learned: number): number {
  const s = Math.max(1, Math.floor(learned / 10));
  const cost = (s * s - 2 * s + 2) * 100;
  return Math.max(1000, cost);
}

/** One row of the teacher's slate: a skill they teach that your class can hold. */
export interface PracticeRow {
  readonly skill: SkillId;
  readonly learned: number;
  readonly ceiling: number;
  /** Copper, or undefined when the row is shown but refused ("cannot practice"). */
  readonly cost?: number;
}

/**
 * What this teacher offers this student — the listing `practice` prints with no argument.
 *
 * A skill appears when the **teacher's class** grants it (that is what makes them the warriors'
 * guildmaster and not a notice board); it carries a price when the **student's class** can learn it
 * and their level has reached the grant. The source shows unpracticeable rows rather than hiding
 * them — "(cannot practice)" — and that is kept: seeing what the hall teaches that you cannot have
 * is how you learn what another life might have been.
 */
export function practiceSlate(
  teacherClass: ClassId,
  student: { readonly classId: ClassId | undefined; readonly level: number; readonly learned: (skill: SkillId) => number },
): PracticeRow[] {
  const rows: PracticeRow[] = [];
  for (const skill of SKILL_IDS) {
    if (ceilingFor(skill, teacherClass) <= 0) continue;
    const ceiling = student.classId ? ceilingFor(skill, student.classId, student.level) : 0;
    const learned = student.learned(skill);
    if (ceiling > 0) rows.push({ skill, learned, ceiling, cost: practiceCost(learned) });
    else rows.push({ skill, learned, ceiling });
  }
  return rows;
}

/**
 * Why this practice is refused, in the source's order, or nothing when the lesson may proceed.
 *
 * `sassyRoll` is the caller's die (1–4) for the twice-the-teacher's-level case — injected so the
 * colour rides the world's seeded stream rather than `Math.random`, which the simulation bans.
 */
export function practiceRefusal(
  args: {
    readonly learned: number;
    readonly ceiling: number;
    readonly studentLevel: number;
    readonly teacherLevel: number;
    readonly canAfford: boolean;
  },
  sassyRoll: number,
): string | undefined {
  const { learned, ceiling, studentLevel, teacherLevel, canAfford } = args;
  if (ceiling <= 0) return 'That is not something I can teach you.';
  if (!canAfford) return "Sorry, boss, but I'm afraid you cannot afford the training.";
  if (studentLevel * 2 < learned) return 'You have not fully grasped your previous lessons. Come back when you have practiced more.';
  if (learned >= studentLevel * 2) return 'You will have to go learn more on your own, I can teach you no more right now.';
  if (learned >= ceiling) return "I'm sorry but I can teach you no more.";
  if (learned >= teacherLevel * 2) {
    switch (((sassyRoll - 1) % 4) + 1) {
      case 1: return 'You are awesome already! Perhaps you would be so kind as to teach me?';
      case 2: return 'You trying to make a fool of me? I can teach you nothing more!';
      case 3: return 'I fear I am not good enough to teach you more.';
      default: return 'Begone from my halls! I do not stand for sarcasm!';
    }
  }
  return undefined;
}
