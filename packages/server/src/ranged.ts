/**
 * The pure half of `fire` / `shoot` / `throw` — ranged slices 3+4, `DESIGN-ranged.md`.
 *
 * Kept beside `peek.ts` for the reason `peek.ts` gives: the rules that matter here are mostly
 * *chances and refusals*, and neither shows its failure on the happy path. A wrong-target roll that
 * never fires, a breakage that fires always, an ammunition search that cannot see inside the quiver —
 * each looks like a working feature in a normal session, so each is a function a test can hold still.
 *
 * What deliberately is not here: the wiring. Announcements, `landBlow`, the reveal gate and the
 * arrow's landing all live in `index.ts`, because they are made of the world.
 */

import type { Inventory, Item, Rng, Stack } from '@mygame/shared';
import { randomInt } from '@mygame/shared';
// The wrong-body pick itself is `pick` from the shared rules — uniform over the others, already seeded.

/* -------------------------------------------------------------------------- */
/* The chances                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Threat per point of ranged damage dealt from **inside** the target's room, as a fraction of what the
 * same blow would earn in melee.
 *
 * The owner's ranger memory is the specification: *"they will want to step back and fire instead of
 * going melee if can … less chance of a mob switching to you."* Half is the design's own precedent
 * rather than a new number — §2.7 credits healing an engaged ally at half the amount, and this is the
 * same shape of statement: helping the fight from a step away is worth a discounted grudge.
 *
 * A **cross-room** shot deliberately does not use this. That shot is the pull, and a pull wants the
 * whole grudge — see the `landBlow` options.
 */
export const RANGED_THREAT_FACTOR = 0.5;

/** Chance a spent missile is destroyed, per shot. "Small … so it is risk you take" — the owner's words. */
const BREAK_CHANCE = 0.05;
/** And the owner's other clause: *"the chance should increase if you are shooting into another room."* */
const BREAK_CHANCE_CROSS_ROOM = 0.1;

/** The breakage chance for one shot. A function rather than two exported numbers so callers cannot mix them up. */
export function breakChance(crossRoom: boolean): number {
  return crossRoom ? BREAK_CHANCE_CROSS_ROOM : BREAK_CHANCE;
}

/**
 * Chance the shot resolves against somebody other than the body it was aimed at, by skill.
 *
 * Linear from 40% at unpractised down to nothing at mastery, so the mechanic retires as the skill
 * grows — *"I might accidently hit the shaman until my skill increases"* is the whole request, and a
 * ceiling-capped class tops out at a few percent rather than zero, which keeps a crowd worth a
 * thought for ever. Rolled only when somebody else is actually standing there: alone with your target
 * there is no wrong body to hit, and rolling anyway would be a miss chance wearing a costume.
 */
export function wrongTargetChance(learned: number): number {
  return 0.4 * Math.max(0, 1 - learned / 100);
}

/** One roll against a `[0,1)` chance, through the seeded rng — no `Math.random` in simulation code. */
export function rollChance(rng: Rng, chance: number): boolean {
  if (chance <= 0) return false;
  return randomInt(rng, 1, 10_000) <= Math.round(chance * 10_000);
}

/* -------------------------------------------------------------------------- */
/* Ammunition                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One missile matching the launcher's key, taken out of the bag — or nothing, and the bag untouched.
 *
 * **The quiver is searched, and that is the point of the function.** A flat scan of the top-level
 * stacks would find a loose arrow and miss a full quiver, and the quiver exists precisely so arrows
 * live in it (`DESIGN-inventory.md` §4). Top level is still preferred when both hold some — a loose
 * arrow is already in reach — and the walk inside containers is depth-1 by the same bound
 * `containers.ts` puts on nesting.
 *
 * Matching is by the **template's** missile key through the injected lookup, not by keyword: `fires 1`
 * must find `&+Gan arrow&N` and `a black-fletched arrow` alike and refuse a drow bolt, which no name
 * test can promise. The five records the harvest refused a key to are unfindable here by construction —
 * an arrow that claims to be type 0 matches no launcher, which is the guard doing its job.
 *
 * Pure over an immutable `Inventory`: the caller gets the next bag and the one missile, and commits
 * both only once the shot is actually happening — a refusal further down the gauntlet must not have
 * already cost an arrow.
 */
export function takeMissile(
  inventory: Inventory,
  fires: number,
  missileTypeOf: (item: Item) => number | undefined,
): { readonly inventory: Inventory; readonly missile: Item } | undefined {
  const stacks = inventory.stacks;
  for (let i = 0; i < stacks.length; i++) {
    const stack = stacks[i]!;
    if (missileTypeOf(stack.item) === fires) {
      return { inventory: { ...inventory, stacks: takeOneAt(stacks, i) }, missile: stack.item };
    }
    const inside = stack.held?.contents;
    if (!inside) continue;
    for (let j = 0; j < inside.length; j++) {
      const inner = inside[j]!;
      if (missileTypeOf(inner.item) !== fires) continue;
      const held = { ...stack.held!, contents: takeOneAt(inside, j) };
      const next = [...stacks.slice(0, i), { ...stack, held }, ...stacks.slice(i + 1)];
      return { inventory: { ...inventory, stacks: next }, missile: inner.item };
    }
  }
  return undefined;
}

/** The stack list with one item fewer at `index` — the stack thinned, or gone when it held its last. */
function takeOneAt(stacks: readonly Stack[], index: number): Stack[] {
  const stack = stacks[index]!;
  return stack.count > 1
    ? [...stacks.slice(0, index), { ...stack, count: stack.count - 1 }, ...stacks.slice(index + 1)]
    : [...stacks.slice(0, index), ...stacks.slice(index + 1)];
}
