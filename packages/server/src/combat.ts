/**
 * Combat: engagement as a relationship, and a round clock per body.
 *
 * `DESIGN-engagement.md` is this module's specification, and Phase 6 exists precisely so that this file
 * could not be written carelessly. Its §8 states the trap plainly: writing `if (distance <= reach)` into
 * the first attack handler silently chooses positional action-RPG combat, and by the time anybody notices,
 * threat and tanking have been built on something that cannot support them.
 *
 * **So there is no distance test anywhere in this file.** Engagement is a pointer. Once two actors are
 * engaged, blows land regardless of where either stands in the room, and the only way out is an event —
 * fleeing, dying, being made unreachable — never a step.
 *
 * ## The shape, from `fight.c`
 *
 * One **outbound** pointer per actor (`Actor.fighting`); the **inbound** set is derived by scanning and is
 * never stored. Mutuality is emergent: {@link engage} does not touch the victim's pointer, and the victim
 * fights back only because {@link retaliate} sets its own. That asymmetry is not an oversight to be
 * tidied — it is what lets a mob keep swinging at a tank while three others hit it from behind.
 *
 * ## The mercy rule is the reason the dying window is not dead code
 *
 * Auto-attacks cross the incapacitation threshold and keep going, so without an explicit rule the interval
 * between "standing" and "dead" is a single tick nobody ever sees. §5: when a target drops below the
 * threshold, **everyone** targeting it disengages — found by scanning, because there is no fight object to
 * read a participant list from. Phase 13 turns that window into death and corpses; today it is where a
 * fight stops.
 */

import {
  DEFENCE_NOTCH_ODDS,
  HP_DEAD_BELOW,
  MIN_ROUND_MS,
  NO_CONTRIBUTION,
  THREAT_PER_DAMAGE,
  THREAT_PER_HEAL,
  addThreat,
  breaksMorale,
  dropThreat,
  markParticipant,
  pickByThreat,
  pickByWeakness,
  threatOf,
  defenceEase,
  dodgeChance,
  parryChance,
  randomInt,
  resolveAttack,
  rollDamage,
  type DefenceEase,
  type EntityId,
  type SkillId,
  type Contribution,
  type Rng,
  type ThreatTable,
} from '@mygame/shared';

import { isMob, isPlayer, type Actor, type Mob, type Player, type Simulation } from './sim.ts';
import { Scheduler, type ScheduledEvent } from './scheduler.ts';

/** One resolved swing, for the caller to put on the wire and in the log. */
export interface AttackOutcome {
  readonly attacker: Actor;
  readonly target: Actor;
  readonly hit: boolean;
  /** The target could not defend itself, so the roll could not have missed. See {@link cannotDefend}. */
  readonly helpless: boolean;
  readonly critical: boolean;
  readonly fumble: boolean;
  readonly damage: number;
  /** The d20 itself, so a fight is auditable and a player can see the roll. */
  readonly natural: number;
  readonly total: number;
  /** Set when this blow took the target below the threshold and ended the fight. */
  readonly incapacitated?: boolean;
  /**
   * **Phase 19 slice 2.** Set when the blow beat the armour class and the defender still got out of it.
   *
   * A defended blow has `hit: false` and no damage, so everything downstream treats it as a miss and
   * nothing has to learn a third state — but it is a *different* miss and the log says so, which is the
   * whole point of an active defence. `chance` rides along because the source's prose grades on it: see
   * `defenceEase`, which describes how good you are at this rather than how close that one was.
   */
  readonly defended?: { readonly kind: 'dodge' | 'parry'; readonly ease: DefenceEase; readonly chance: number };
  /**
   * A defensive skill the **defender** should roll a notch for, because it just failed them.
   *
   * Reported rather than applied, for the reason `Death` carries a ledger rather than paying it: writing
   * a skill means a message, a save and an `attackBonus` refit, none of which this file knows about.
   */
  readonly defenceNotch?: SkillId;
}

/** What a combat tick produced. */
export interface CombatTick {
  readonly attacks: readonly AttackOutcome[];
  /** Actors whose engagement pointer changed, so the caller can re-send their `EntityView`. */
  readonly changed: readonly Actor[];
  /** Mobs that turned on somebody new this tick, with who they left and who they took up. */
  readonly switches: readonly TargetSwitch[];
  /** Anything that died this tick, with the ledger the caller pays out from. */
  readonly deaths: readonly Death[];
  /** Mobs that got back on their feet this round — the caller says so ("$n clambers to $s feet."). */
  readonly stood: readonly Actor[];
}

/** One body reaching the end of the status ladder. */
export interface Death {
  readonly actor: Actor;
  /** Who struck the final blow — for the log, and for nothing else. */
  readonly killer: Actor | undefined;
  /**
   * Everyone who contributed, and what they did.
   *
   * Read from the ledger *at the moment of death* and handed over, because the ledger entry is dropped
   * immediately afterwards — a mob that dies and respawns on the next zone tick must not inherit a
   * grudge, or its own experience, from the thing that stood there before it.
   */
  readonly contributions: ReadonlyMap<number, Contribution>;
}

/** One mob changing its mind about who it is fighting. */
export interface TargetSwitch {
  readonly mob: Mob;
  readonly from: Actor | undefined;
  readonly to: Actor;
}

/**
 * What each character did to one mob, for dividing its experience.
 *
 * **Beside the threat table rather than inside it, because they answer different questions.** Threat is
 * *"whom do I hate most right now"* and decays with the fight; contribution is *"who earned a share of
 * this"* and must survive until the kill is paid out. A tank who took a beating and then had aggro
 * pulled off them has low threat and a large share, and one map could not say both.
 */
export type LedgerBook = Map<number, Map<number, Contribution>>;

export function ledgerFor(book: LedgerBook, mobId: number): Map<number, Contribution> {
  const existing = book.get(mobId);
  if (existing) return existing;
  const ledger = new Map<number, Contribution>();
  book.set(mobId, ledger);
  return ledger;
}

/** Adds to one character's line in a mob's ledger. */
export function credit(
  book: LedgerBook,
  mobId: number,
  actorId: number,
  add: Partial<Contribution>,
): void {
  const ledger = ledgerFor(book, mobId);
  const current = ledger.get(actorId) ?? NO_CONTRIBUTION;
  ledger.set(actorId, {
    dealt: current.dealt + (add.dealt ?? 0),
    taken: current.taken + (add.taken ?? 0),
    supported: current.supported + (add.supported ?? 0),
  });
}

/**
 * Every mob's threat table, by mob id.
 *
 * Beside the actor rather than on it, like `MobAwareness` and `Hunt` — a `Mob` is a body, and Phase 7's
 * split exists to keep it one. Cleared when the mob stops fighting, so an empty map is the normal state
 * of the world: 92 mobs stand in IceCrag and at most a handful ever hold a table.
 */
export type ThreatBook = Map<number, ThreatTable>;

export function threatTableFor(book: ThreatBook, mob: Mob): ThreatTable {
  const existing = book.get(mob.id);
  if (existing) return existing;
  const table: ThreatTable = new Map();
  book.set(mob.id, table);
  return table;
}

/**
 * Puts a supporter into every fight the person they helped is in.
 *
 * **The one call a heal, a buff or a protection spell has to make.** Helping somebody who is fighting is
 * joining that fight: the mob has no way to tell the difference between the sword and the hand that kept
 * the swordsman upright, and it should not — otherwise the front line dies and the thing walks away from
 * the healer who held the party together for five minutes.
 *
 * Marks *presence*, and takes an optional amount for the threat that ordering uses (§2.7 puts healing at
 * {@link THREAT_PER_HEAL} of the amount restored). A heal that restored nothing still counts, which is
 * why the two are separate arguments rather than one number.
 *
 * **Nothing calls this yet** — healing and protection are Phase 20 — and it is here rather than there so
 * that the rule lives beside the table it writes to, instead of being re-derived beside the first spell.
 */
export function joinBySupporting(
  book: ThreatBook,
  ledger: LedgerBook,
  sim: Simulation,
  supporter: Actor,
  ally: Actor,
  threat = 0,
): Mob[] {
  const joined: Mob[] = [];
  // Every mob currently swinging at the ally, and the one the ally is swinging at — both directions,
  // because helping somebody being beaten and helping somebody attacking are the same act to a mob.
  const foes = new Set<number>(attackersOf(sim, ally.id).map((a) => a.id));
  if (ally.fighting !== undefined) foes.add(ally.fighting);

  for (const id of foes) {
    const foe = sim.get(id);
    if (!foe || !isMob(foe)) continue;
    const table = threatTableFor(book, foe);
    if (threat > 0) addThreat(table, supporter.id, threat);
    else markParticipant(table, supporter.id);
    // And a share of the kill. One act, not an amount — see `VALUE_PER_SUPPORT_ACT` for why paying by
    // amount healed would make a healer's share depend on how badly the tank was playing.
    credit(ledger, foe.id, supporter.id, { supported: 1 });
    joined.push(foe);
  }
  return joined;
}

/** Forgets a character across every table — they died, disconnected, or left. */
export function forgetThreat(book: ThreatBook, actorId: EntityId): void {
  for (const table of book.values()) dropThreat(table, actorId);
}

/* -------------------------------------------------------------------------- */
/* Starting and stopping                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Whether this body is in any state to open a fight.
 *
 * §3's refusals, and note what is *not* here: there is no range check and no crowding check. Crowding —
 * the source's `can_hit_target`, *"You can't seem to find room!"* — is a **cardinality** limit rather than
 * a distance one and is not scheduled; recording that here is how it stays understood as one.
 */
export function canEngage(actor: Actor): boolean {
  // Read off the body as it stands rather than recomputed from hit points: a sleeper is asleep because
  // something put them there, and `statusFor` would answer about their health instead.
  if (actor.status === 'sleeping') return false;
  return !incapacitated(actor);
}

/**
 * Mob templates no violence may touch — quest givers, seeded at boot from `quests.json` (owner's
 * rule, 2026-08-08: *"we need to make quest mobs un-attackable and undamageable in case some
 * caster decides to cast a room effect spell"*). A registry rather than a flag on the instance,
 * so an admin-spawned copy of a giver is exactly as sacred as the placed one.
 */
const UNTOUCHABLE_VNUMS = new Set<number>();

export function setUntouchableVnums(vnums: Iterable<number>): void {
  UNTOUCHABLE_VNUMS.clear();
  for (const vnum of vnums) UNTOUCHABLE_VNUMS.add(vnum);
}

/** Whether violence may reach this body at all. The quest giver's whole armour. */
export function isUntouchable(target: Actor): boolean {
  return isMob(target) && UNTOUCHABLE_VNUMS.has(target.vnum);
}

/**
 * Whether a body is still worth swinging at.
 *
 * **Mercy is a player's protection, and a mob has nothing to protect.** A character who goes down enters
 * the dying window — a real interval where they are alive, findable and rescuable, and Phase 13 turns it
 * into death or recovery. A mob has no such window in play: it fights to the death, and stopping at
 * "incapacitated" would leave a creature standing at −4 hit points that nobody may finish, which is not
 * a mechanic but a bug wearing one.
 *
 * So the two kinds diverge here and nowhere else: a **player** stops being a target the moment they are
 * incapacitated, and a **mob** stops only when it is dead — at which point there is nothing left to point
 * at and Phase 13 takes the body away.
 */
export function canBeAttacked(target: Actor): boolean {
  // The giver gate sits here on purpose: `shouldAreaHit` already asks this question for every
  // area victim, so earthquake and ice storm skip the untouchable with no loop knowing why.
  if (isUntouchable(target)) return false;
  if (isPlayer(target)) return !incapacitated(target);
  return target.status !== 'dead';
}

/**
 * Points `attacker` at `target`, and schedules its first swing.
 *
 * **Refuses an actor that is already fighting**, which is `set_fighting`'s own contract — an assertion
 * failure upstream, not a re-target. §2: switching target is *stop-then-set*, so a caller that wants to
 * change opponents calls {@link disengage} first. One code path means a switch cannot leave a stale
 * pointer behind, which is the bug Phase 12's threat table would otherwise introduce on its first day.
 */
export function engage(
  scheduler: Scheduler,
  attacker: Actor,
  target: Actor,
  options: { readonly immediate?: boolean } = {},
): boolean {
  if (attacker.id === target.id) return false;
  if (attacker.fighting !== undefined) return false;
  if (!canEngage(attacker) || !canBeAttacked(target)) return false;
  // Same room, and that is the only spatial condition in this module. It is a *containment* test, not a
  // range one: §1's whole point is that where you stand inside the room buys you nothing.
  if (attacker.roomId !== target.roomId) return false;

  attacker.fighting = target.id;
  // The first blow waits a round, so opening a fight is not a free hit and the person you jumped has the
  // same beat to answer in that Phase 9's reaction gave them to run.
  scheduler.cancel(attacker.id, 'swing');
  scheduler.schedule('swing', attacker.id, options.immediate ? 0 : Math.max(MIN_ROUND_MS, attacker.roundMs));
  return true;
}

/**
 * Clears one actor's pointer. **Not symmetric** — it touches nobody else's.
 *
 * §2: `stop_fighting(ch)` clears `ch` and only `ch`. A mob whose target fled is still engaged until
 * something clears it too, which is what §5's enumeration is for and why the mercy rule has to scan.
 */
export function disengage(scheduler: Scheduler, actor: Actor): boolean {
  if (actor.fighting === undefined) return false;
  actor.wasFighting = actor.fighting;
  actor.fighting = undefined;
  scheduler.cancel(actor.id, 'swing');
  return true;
}

/** Everyone currently swinging at this actor. Derived by scanning — there is no participant list. */
export function attackersOf(sim: Simulation, target: EntityId): Actor[] {
  const out: Actor[] = [];
  for (const actor of sim.allActors()) if (actor.fighting === target) out.push(actor);
  return out;
}

/**
 * A victim answering back, if it is not already busy.
 *
 * This is the *only* thing that makes a fight mutual, and it is a separate call by design: a mob already
 * swinging at somebody else does not drop them to answer you, which is what makes holding aggro a thing
 * you can do before there is a threat table to do it with.
 */
export function retaliate(scheduler: Scheduler, victim: Actor, attacker: Actor): boolean {
  if (victim.fighting !== undefined) return false;
  return engage(scheduler, victim, attacker);
}

/**
 * Clears every pointer aimed at an actor, and its own. Returns everyone changed.
 *
 * The mercy rule's mechanism, and also what a departure needs: §5 lists "target becomes unreachable —
 * changed Place, disconnected, despawned" alongside death, and all of them want exactly this.
 */
export function clearEngagements(scheduler: Scheduler, sim: Simulation, actor: Actor): Actor[] {
  const changed: Actor[] = [];
  if (disengage(scheduler, actor)) changed.push(actor);
  for (const other of attackersOf(sim, actor.id)) {
    if (disengage(scheduler, other)) changed.push(other);
  }
  return changed;
}

export interface RescueResult {
  /** The one attacker peeled off — the *first* found, which is the source's own rule. */
  readonly attacker: Actor;
  /** Everyone whose engagement pointer moved, for the caller's entity resync and self pushes. */
  readonly changed: readonly Actor[];
}

/**
 * The mechanism of a rescue: **one** attacker peeled off the rescuee and onto the rescuer —
 * **Phase 19 slice 4**, from `rescue()` (`actoff.c:7261`).
 *
 * The source walks the room and, for the first body whose opponent is the rescuee: the rescuee's own
 * pointer at it is cleared (`stop_fighting(rescuee)`, only when it aims there), the attacker is turned
 * (`stop_fighting(t_ch); set_fighting(t_ch, ch)`), and the rescuer engages if free. *First and only
 * first* — peeling everyone is `rescue all`, a level-46 Guardian specialisation that waits for Phase
 * 21's classes. Both turns go through {@link disengage}-then-{@link engage}, the stop-then-set
 * contract, so the attacker's next blow waits a fresh round exactly as the source's timing reset does.
 *
 * ## `set_fighting` is not enough here, and this is the transcription decision
 *
 * Duris' pointer *is* the mob's whole mind, so moving it moves the fight. Ours re-decides on every
 * round boundary from the threat table, and the rescuee usually tops it — a bare pointer flip would
 * un-rescue itself within three seconds, when {@link pickByThreat} found the rescuer's near-zero score
 * unable to defend the `current` slot. So the redirect also **seats the rescuer at the rescuee's own
 * standing** on the attacker's table: the mob transfers its grudge with the fight, the hysteresis
 * margin now protects the rescuer, and the rescuee wins the mob back only by out-threatening them by
 * 10% — which is tanking working as §2.7 designed it, not a new rule.
 *
 * The rescuer also joins the fight the way any helper does: {@link joinBySupporting} — its first
 * caller, two phases after it was written — marks them on **every** foe's table and credits one
 * support act in the ledger, so pulling a mob off somebody earns a share of what it pays.
 */
export function rescueFrom(
  deps: {
    readonly sim: Simulation;
    readonly scheduler: Scheduler;
    readonly book: ThreatBook;
    readonly ledger: LedgerBook;
  },
  rescuer: Actor,
  rescuee: Actor,
): RescueResult | undefined {
  const { sim, scheduler, book, ledger } = deps;
  // The caller refuses "rescue my own target" with the source's own line; the filter here is the same
  // rule as a guard rather than a second opinion, so a peeled attacker can never be the rescuer.
  const attacker = attackersOf(sim, rescuee.id).find((a) => a.id !== rescuer.id);
  if (!attacker) return undefined;

  // Participation first, while the pointers still describe the fight being interrupted —
  // `joinBySupporting` reads them to find the foes.
  joinBySupporting(book, ledger, sim, rescuer, rescuee);

  // The grudge transfers with the fight — see the module note above for why this is the one addition
  // to the source's own sequence.
  if (isMob(attacker)) {
    const table = threatTableFor(book, attacker);
    const deficit = threatOf(table, rescuee.id) - threatOf(table, rescuer.id);
    if (deficit > 0) addThreat(table, rescuer.id, deficit);
  }

  const changed: Actor[] = [];
  if (rescuee.fighting === attacker.id && disengage(scheduler, rescuee)) changed.push(rescuee);
  const turned = disengage(scheduler, attacker);
  const reEngaged = engage(scheduler, attacker, rescuer);
  if (turned || reEngaged) changed.push(attacker);
  if (rescuer.fighting === undefined && engage(scheduler, rescuer, attacker)) changed.push(rescuer);

  return { attacker, changed };
}

/* -------------------------------------------------------------------------- */
/* The round                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether a body can still defend itself.
 *
 * **A creature that cannot defend is not missed.** There is no dodging, no parry and no armour roll
 * against a blow aimed at something already on the floor — so the d20 is still rolled and still printed,
 * because a fight has to stay auditable, but it cannot produce a miss. The SRD reaches the same place
 * from the other direction: attacks against an incapacitated creature have advantage, and a melee attack
 * inside five feet is an automatic critical.
 *
 * Sleeping counts for the same reason incapacitated does. The critical half of the SRD's rule is
 * deliberately *not* taken: doubling every finishing blow's dice makes the last hit of every fight the
 * biggest number in the log, which reads as a bug rather than as mercy being over.
 */
export function cannotDefend(actor: Actor): boolean {
  return actor.status === 'sleeping' || incapacitated(actor);
}

/**
 * Whether a body has been taken out of the fight.
 *
 * The mercy threshold. Duris stops at `POSITION_INCAP`; our equivalent is the point on Phase 4's status
 * ladder where you are no longer acting, which `statusFor` already names.
 */
export function incapacitated(actor: Actor): boolean {
  return actor.status === 'incapacitated' || actor.status === 'dying' || actor.status === 'dead';
}

/**
 * Resolves one swing.
 *
 * All of the SRD maths is `rules.ts`'s, called here for the first time since it was written: `resolveAttack`
 * rolls the d20 and applies the natural-20-always-hits and natural-1-always-misses rules, and `rollDamage`
 * doubles the dice on a critical. This function's own job is only to decide *who* and to apply the result.
 */
function swing(
  rng: Rng,
  attacker: Actor,
  target: Actor,
  defence: DefenceSkills | undefined,
  attackers: number,
): AttackOutcome {
  const result = resolveAttack(rng, {
    attackBonus: attacker.combat.attackBonus,
    targetAc: target.combat.armourClass,
  });
  // The roll still happens and is still reported — a fight must stay auditable, and a log that silently
  // stopped showing dice on the last few blows would be worse than one that shows a die that could not
  // have failed. What changes is only the verdict. See {@link cannotDefend}.
  const helpless = cannotDefend(target);
  const beatArmour = helpless || result.hit;

  // **The second gate, and only once the first has been passed.** `new_combat.c` runs dodge and parry
  // *inside* the branch that the to-hit already won, so a blow that missed stays a miss and cannot be
  // dodged — you do not get to duck something that was never going to reach you. A helpless body does not
  // defend at all, which is `canCharDodgeParry`'s own gate reading the same status ladder.
  // **`rolled` is the wrapper and `rolled.defended` is the verdict**, and conflating the two shipped a
  // bug that made *every blow in the game miss*: `rollDefence` always returns an object — it carries the
  // notch even when nothing was defended — so testing the wrapper for truthiness meant `hit` was false
  // whenever a defence lookup was wired at all. The unit tests never saw it because they leave `defence`
  // undefined, which is exactly the shape that skips the branch. See the test that now covers it.
  const rolled = beatArmour && !helpless && defence
    ? rollDefence(rng, defence, attackers, result.critical ? Math.floor((result.natural - 20 + result.total) / 2) : 0)
    : undefined;
  const defended = rolled?.defended;

  const hit = beatArmour && !defended;
  const damage = hit ? rollDamage(rng, attacker.combat.damage, result.critical) : 0;
  // **The damage is not applied here.** It used to be, and moving it into {@link landBlow} is what lets an
  // ability share one path with a swing — see that function. This one decides *what* a blow is worth; what
  // a landed blow does to the world is the same question however it was thrown.
  return {
    attacker,
    target,
    hit,
    helpless,
    // A natural 1 against something that cannot defend is not a fumble; it is a blow that landed on a
    // body which was not going to stop it either way.
    critical: result.critical,
    fumble: !helpless && result.fumble,
    damage,
    natural: result.natural,
    total: result.total,
    ...(defended ? { defended } : {}),
    ...(rolled?.notch ? { defenceNotch: rolled.notch } : {}),
  };
}

/**
 * Dodge, then parry — the two rolls in the source's order, with the failed one's notch.
 *
 * **Dodge first and parry only if it failed**, which is not interchangeable: they are two chances rather
 * than one, so a defender with both gets both, and a defender who dodges never rolls parry at all. The
 * notch attaches to whichever *failed you*, on the source's own coin flip — you learn from the blow that
 * got through your dodge, not from the one you avoided.
 *
 * `overshoot` is the critical quirk from `defence.ts`'s module note, computed by the caller and zero for
 * an ordinary hit.
 */
function rollDefence(
  rng: Rng,
  skills: DefenceSkills,
  attackers: number,
  overshoot: number,
): { defended?: AttackOutcome['defended']; notch?: SkillId } {
  const dodge = dodgeChance({ skill: skills.dodge, attackers, criticalOvershoot: overshoot });
  // `number(1, 101)` in the source — a 101-sided roll against a chance capped at 100, so even a perfect
  // score fails one time in a hundred and one. Transcribed rather than tidied to `1..100`: a defence that
  // never, ever fails is a different game.
  if (randomInt(rng, 1, 101) <= dodge) {
    return { defended: { kind: 'dodge', ease: defenceEase(dodge), chance: dodge } };
  }
  const dodgeNotch = rng() < DEFENCE_NOTCH_ODDS ? ('dodge' as SkillId) : undefined;

  const parry = parryChance({
    parrySkill: skills.parry,
    weaponSkill: skills.weapon,
    attackers,
    armed: skills.armed,
  });
  if (randomInt(rng, 1, 101) <= parry) {
    // The dodge notch is dropped here rather than kept, and deliberately: the source rolls its coin,
    // notches, and then goes on to the parry — but only one skill can be reported per blow through
    // `defenceNotch`, and the one the defender actually needed is the one that saved them. Naming the
    // parry would be wrong (it succeeded), so a blow that is parried teaches nothing, which is the same
    // rule the successful dodge above follows.
    return { defended: { kind: 'parry', ease: defenceEase(parry), chance: parry } };
  }
  const parryNotch = rng() < DEFENCE_NOTCH_ODDS ? ('parry' as SkillId) : undefined;

  // Both failed. Dodge is offered first because it was rolled first; a blow teaches at most one thing.
  const notch = dodgeNotch ?? parryNotch;
  return notch === undefined ? {} : { notch };
}

/**
 * "This mob's nerve has gone — get it out if you can, and say so." Returns whether it left.
 *
 * Injected rather than called directly, exactly as `advanceAssists` takes `perceives`: breaking off means
 * moving a body through the room graph and telling every client that can see it, and this file knows
 * about neither. `index.ts` implements it over `attemptFlee`, which is also what a player's own `flee`
 * runs — so a servant bolting and a character escaping cannot come to disagree about what leaving a
 * fight means.
 */
export type MoraleCheck = (mob: Mob) => boolean;

/**
 * What a defender brings to the two rolls — **Phase 19 slice 2**.
 *
 * Injected the way `MoraleCheck` is, and for the same reason: resolving these means reading a player's
 * skill map through `learnedAt`, and a mob's through its level and its class-that-does-not-exist-yet.
 * This file knows about neither, and a second copy of that resolution would be a second chance for a
 * player's dodge and a mob's to drift apart.
 */
export interface DefenceSkills {
  /** `SKILL_DODGE`, 0–100. */
  readonly dodge: number;
  /** `SKILL_PARRY`, 0–100. Half of the parry chance; the other half is {@link weapon}. */
  readonly parry: number;
  /** The skill of whatever is in the defender's hand — `getWeaponSkillNumb(weapon)`. */
  readonly weapon: number;
  /** Whether there is anything in that hand at all. **No weapon, no parry.** */
  readonly armed: boolean;
}

export type DefenceLookup = (defender: Actor) => DefenceSkills;

/** What a landed blow did to the world. See {@link landBlow}. */
export interface BlowResult {
  /**
   * The target is out of the fight — the mercy rule for a player, death for a mob.
   *
   * The caller decides what to *say* about that; this reports it, because a kick that fells somebody and
   * a swing that does are the same fact and must not be two.
   */
  readonly incapacitated: boolean;
  /** Everyone whose engagement changed and therefore needs a resync. */
  readonly changed: readonly Actor[];
  /** Set when a **mob** died, with the ledger to pay out from. A player has a dying window instead. */
  readonly death?: Death;
}

/**
 * **Everything that happens because a blow landed, whatever threw it.**
 *
 * Extracted from the swing loop 2026-08-06 with no behaviour change, and the reason is Phase 19's third
 * slice: `bash` and `kick` need it, `rescue` will, and every damaging spell in Phase 20 will. An ability
 * that applied damage itself would be a **second damage path**, and the failure modes are specific rather
 * than theoretical — a mob dying without paying experience because nothing credited the ledger, a bash that
 * kills leaving no corpse because nothing pushed a `Death`, a felled target that everyone keeps swinging at
 * because nothing cleared the engagements. Each of those is one forgotten line in a copy of this function.
 *
 * Six things, in this order, and the order is load-bearing:
 *
 * 1. **The damage lands**, clamped at the bottom of the status ladder rather than at zero — see below.
 * 2. **Threat**, credited to whoever dealt it (§2.7).
 * 3. **The ledger**, both halves: `dealt` against a mob, and `taken` when a mob is the one hitting — Phase
 *    13's rule that absorbing a fight earns a share of it, which is what makes tanking viable with no role
 *    system to reward it.
 * 4. **Retaliation**, which happens *whether or not the blow connected*: being swung at is enough to
 *    notice. (A caller with a blow that missed still calls this with zero damage.)
 * 5. **The status refresh**, before the mercy test, so that test sees the result of *this* blow rather than
 *    the previous tick's.
 * 6. **The mercy rule and death**, which is why 5 cannot be deferred.
 */
export function landBlow(
  deps: {
    readonly sim: Simulation;
    readonly scheduler: Scheduler;
    readonly book: ThreatBook;
    readonly ledger: LedgerBook;
  },
  attacker: Actor,
  target: Actor,
  damage: number,
): BlowResult {
  const { sim, scheduler, book, ledger } = deps;
  // Belt under the braces: whatever path composed this blow — a targeted nuke, a stray bolt, an
  // ability that resolved oddly — an untouchable body takes nothing from it. The gate above
  // covers every path that *asks*; this covers the one that forgets to.
  if (isUntouchable(target)) return { incapacitated: false, changed: [] };
  const changed: Actor[] = [];

  // **Not clamped at zero, and that is the whole dying window.** Phase 4's thresholds are negative in the
  // Diku manner — `incapacitated` at −3, `dying` at −6, `dead` below −10 — so a floor of 0 would make the
  // entire ladder between "standing" and "dead" unreachable and the mercy rule dead code. Clamped at the
  // bottom of the ladder instead, so a 50-point blow on a 1 hp character lands them dead rather than at
  // −49, which nothing reads and which would make a resurrection mechanic arbitrary later.
  if (damage > 0) target.hp = Math.max(HP_DEAD_BELOW - 1, target.hp - damage);

  // Threat, credited to whoever dealt it. Damage only for now — §2.7's other source is healing an
  // engaged ally at half the amount, and there is no healing until Phase 20.
  if (isMob(target) && damage > 0) {
    addThreat(threatTableFor(book, target), attacker.id, damage * THREAT_PER_DAMAGE);
    credit(ledger, target.id, attacker.id, { dealt: damage });
  }
  // And the other half of the phase's rule: **damage taken counts too.** A tank standing in front of
  // something for a whole fight has earned a share of it, which is what makes tanking viable with no
  // role system to reward it. Credited against the mob doing the hitting.
  if (isMob(attacker) && damage > 0) {
    credit(ledger, attacker.id, target.id, { taken: damage });
  }

  // Being hit is what makes a fight mutual — and it happens whether or not the blow connected, because
  // being swung at is enough to notice. `retaliate` refuses if the victim is already busy.
  if (retaliate(scheduler, target, attacker)) changed.push(target);

  // Vitals may have moved the target down the status ladder. Recomputed here rather than waited for,
  // because the mercy rule below has to see the *result* of this blow, not the previous tick's.
  sim.refreshStatus(target, target.fighting !== undefined);

  if (canBeAttacked(target)) return { incapacitated: false, changed };

  // **The mercy rule, for a player** — and for a mob, simply the end of it: there is nothing left to
  // swing at. Either way everyone targeting them stops, found by *scanning*, per §2's second
  // consequence. Without this the player's dying window would be dead code, because the next swing
  // lands in the same second and carries straight through it.
  for (const actor of clearEngagements(scheduler, sim, target)) changed.push(actor);

  // **Death, for a mob.** A player at this point is in the dying window and is Phase 13's other half; a
  // mob has no window and reaching here means it is dead. The ledger is handed over and then dropped,
  // because the corpse is about to replace the body and a respawn must not inherit either the grudge or
  // the payout.
  if (isMob(target) && target.status === 'dead') {
    const death: Death = {
      actor: target,
      killer: attacker,
      contributions: new Map(ledgerFor(ledger, target.id)),
    };
    ledger.delete(target.id);
    book.delete(target.id);
    return { incapacitated: true, changed, death };
  }
  return { incapacitated: true, changed };
}

/**
 * Advances every fight by one tick.
 *
 * Driven by the scheduler rather than by a scan: a `swing` event comes due, is resolved, and reschedules
 * itself a round later. Most ticks pop nothing at all, which is the shape §4.1 wants and the reason the
 * queue exists — 92 mobs stand in IceCrag and at most a few are ever swinging.
 *
 * **This function is handed the tick's due events; it no longer drains the scheduler itself** — Phase
 * 20's mandatory first commit, restructured with no behaviour change. It used to hold the codebase's
 * only `scheduler.advance()` call and silently discard every kind it did not know, which meant any new
 * event kind — a spell's wind-up, most immediately — would pop here and vanish. The tick loop drains
 * once and routes by kind; this function still ignores everything but `swing`, because a swing is the
 * one kind that is *its* business, and the filter is its contract rather than a leak.
 */
export function advanceCombat(
  sim: Simulation,
  scheduler: Scheduler,
  book: ThreatBook,
  ledger: LedgerBook,
  rng: Rng,
  due: readonly ScheduledEvent[],
  morale?: MoraleCheck,
  /** Phase 19 slice 2. Absent means nobody dodges or parries — combat exactly as it was before. */
  defence?: DefenceLookup,
  /**
   * Phase 20 slice 3. A mob's chance to open a wind-up instead of swinging, on its round boundary.
   * Returns true when it took the round; absent means no mob anywhere casts — combat as it was.
   */
  tryCast?: (mob: Mob, target: Actor) => boolean,
): CombatTick {
  const attacks: AttackOutcome[] = [];
  const changed: Actor[] = [];
  const switches: TargetSwitch[] = [];
  const deaths: Death[] = [];
  const stood: Actor[] = [];

  // **A mob that lost its target picks up the next one.**
  //
  // This pass exists because retargeting inside the swing loop below can only reach mobs that still have
  // a swing scheduled — and a mob whose opponent died, fled or disconnected has been *disengaged*, so it
  // has none. Without this it simply stops, standing in a room with somebody still hitting it, which is
  // the opposite of §2.7's *"the mob falls to the next entry"*. Found live: a tank disconnected mid-fight
  // and the sergeant it had been fighting lost interest in the whole room.
  //
  // Iterates the threat book rather than every actor, so it costs one map walk over the handful of mobs
  // that have ever been in a fight rather than a scan over ninety-two standing inhabitants.
  for (const [mobId, table] of book) {
    const mob = sim.get(mobId);
    if (!mob || !isMob(mob)) {
      book.delete(mobId);
      continue;
    }
    if (mob.fighting !== undefined || !canEngage(mob)) continue;
    // No margin to clear: there is no current target to defend. And `pickByThreat` will only ever name
    // somebody who actually hurt it, which is what keeps a bar fight from spilling onto the other
    // drinkers — see `threat.ts`.
    const wanted = pickByThreat(table, reachableTargets(sim, mob), undefined);
    if (wanted === undefined) {
      // Nobody it has a grudge against is still here. Drop the table rather than keep one: §2.7's
      // *"threat decays when a target becomes unreachable or leaves combat, otherwise whoever landed the
      // first blow keeps aggro forever after running away."* A grudge that outlives the fight is
      // `MobAwareness`'s job, not threat's, and it does not make you a target — only recognised.
      book.delete(mobId);
      continue;
    }
    const next = sim.get(wanted);
    if (next && engage(scheduler, mob, next)) {
      switches.push({ mob, from: undefined, to: next });
      changed.push(mob);
    }
  }

  for (const event of due) {
    if (event.kind !== 'swing') continue;
    const attacker = sim.get(event.actor);
    if (!attacker || attacker.fighting === undefined) continue;

    // **Retarget first, on the round boundary.** This has to come before the reachability bail below, or
    // a mob whose leader walked out of the room disengages entirely instead of falling to the next entry
    // — §2.7's *"when the top-threat target cannot be reached, the mob falls to the next"*. The order was
    // the other way round first, and the symptom was a mob that simply gave up when you stepped away
    // while somebody else was still hitting it.
    //
    // §2.7's hysteresis lives in `pickByThreat`; what matters here is *when* it is consulted. A mob that
    // re-evaluated every tick would turn mid-swing, and one that only re-evaluated on its target's death
    // could never be pulled off a healer.
    if (isMob(attacker)) {
      const wanted = pickByThreat(threatTableFor(book, attacker), reachableTargets(sim, attacker), attacker.fighting);
      if (wanted !== undefined && wanted !== attacker.fighting) {
        const next = sim.get(wanted);
        if (next) {
          // Stop-then-set, per §2: `engage` refuses an actor that is already fighting, so a switch has to
          // go through `disengage` first. This is the call site that rule was written for.
          const previous = sim.get(attacker.fighting ?? -1);
          disengage(scheduler, attacker);
          if (engage(scheduler, attacker, next, { immediate: true })) {
            switches.push({ mob: attacker, from: previous, to: next });
            changed.push(attacker);
            // The new engagement scheduled its own immediate swing; this event has been superseded.
            continue;
          }
        }
      }
    }

    const target = attacker.fighting === undefined ? undefined : sim.get(attacker.fighting);
    // §5's "target becomes unreachable". Checked at the moment of the swing rather than trusted from when
    // it was scheduled, for the same reason Phase 9 revalidates its reaction: a round is three seconds and
    // the world moves inside it. By here the threat table has already had its say, so reaching this means
    // there was genuinely nobody else to turn to.
    if (!target || target.roomId !== attacker.roomId || !canBeAttacked(target)) {
      if (disengage(scheduler, attacker)) changed.push(attacker);
      continue;
    }
    // An attacker who has been knocked out mid-round stops, and is not rescheduled.
    if (incapacitated(attacker)) {
      if (disengage(scheduler, attacker)) changed.push(attacker);
      continue;
    }

    // **A fighting mob that was knocked down stands back up** — `mobact.c:7091` (mundane_autostand):
    // below standing and still in a fight, `do_stand` and then *carry on with the round* (`goto
    // normal`), so the bash's lag was the whole cost and the knockdown is not paid for twice. Slice
    // 3's drive found the gap: nothing else ever stands a mob up, so the first mechanic to read a
    // mob's posture — the cast beat — turned one knockdown into a permanent silence. A player is
    // deliberately not stood here: standing back up is their decision, and their `stand` command.
    if (isMob(attacker) && attacker.posture !== 'standing') {
      sim.setStance(attacker, { posture: 'standing' });
      changed.push(attacker);
      stood.push(attacker);
    }

    // **Morale, on the round boundary** — `DESIGN-mobs-and-movement.md` §2.8. A mob below its template's
    // threshold turns to run *instead of* swinging, because it has stopped fighting you.
    //
    // Here rather than per tick, and that is the mechanic rather than an optimisation: a body that
    // re-evaluated ten times a second would break and rally inside a single swing. And note what happens
    // when the attempt fails — nothing. It falls through and fights this round, so **a coward you have
    // cornered is not a harmless one**, which is what stops "block the only exit" from being a way to
    // switch a mob off.
    if (morale && isMob(attacker) && breaksMorale(attacker.hp, attacker.wimpyAt) && morale(attacker)) {
      // Gone: the callback moved it, cleared every pointer aimed at it and told everyone who could see.
      // Its swing event has already been popped and `disengage` cancelled any successor, so there is
      // nothing here to reschedule.
      continue;
    }

    // **Phase 20 slice 3: a caster is a held piece here too.** A body mid-wind-up does not swing —
    // its swing was cancelled at cast start and this is the belt for the event already in flight —
    // and a mob that knows spells may reach for one *instead of* swinging, on its own round boundary
    // exactly as morale is asked there. When `tryCast` takes the round, the cast's own ending gives
    // the swing back, so nothing is rescheduled here; the injection decides everything else
    // (which spell, the wind-up, the messages), because what a shaman knows is content and content
    // stays on `index.ts`'s side of the seam.
    if (attacker.casting) continue;
    if (tryCast && isMob(attacker) && tryCast(attacker, target)) continue;

    // How many people are on this defender right now — the one modifier from the source's hundred lines
    // that we have the number for, and the one that matters: it is why ganging up works.
    const crowd = defence ? attackersOn(sim, target) : 1;
    const outcome = swing(rng, attacker, target, defence?.(target), crowd);
    const landed = landBlow({ sim, scheduler, book, ledger }, attacker, target, outcome.damage);
    for (const actor of landed.changed) changed.push(actor);
    if (landed.death) deaths.push(landed.death);

    if (landed.incapacitated) {
      attacks.push({ ...outcome, incapacitated: true });
      continue;
    }

    attacks.push(outcome);
    // Next round. Rescheduled after resolving rather than before, so a round length changed mid-fight
    // (haste, a weapon swap) takes effect from the following swing rather than retroactively.
    scheduler.schedule('swing', attacker.id, Math.max(MIN_ROUND_MS, attacker.roundMs));
  }

  return { attacks, changed, switches, deaths, stood };
}

/** How many bodies in the room are currently fighting this one. `GET_OPPONENT(tch) == vict`, verbatim. */
function attackersOn(sim: Simulation, defender: Actor): number {
  let count = 0;
  for (const actor of sim.actorsIn(defender.roomId)) if (actor.fighting === defender.id) count++;
  return count;
}

/** Everyone a mob could legally be swinging at right now: same room, and still a target. */
export function reachableTargets(sim: Simulation, mob: Mob): number[] {
  const out: number[] = [];
  for (const actor of sim.actorsIn(mob.roomId)) {
    // Players only. A mob objecting to another mob is faction fighting, which nothing models.
    if (!isPlayer(actor) || !canBeAttacked(actor)) continue;
    out.push(actor.id);
  }
  return out;
}

/**
 * Who a mob should open on, when it has no history to read.
 *
 * Duris' own rule — the weakest-looking body in the room — used only here. See `threat.ts` for why both
 * rules are kept and which moment each owns.
 */
export function openingTarget(sim: Simulation, mob: Mob): Actor | undefined {
  const candidates = [];
  for (const actor of sim.actorsIn(mob.roomId)) {
    if (!isPlayer(actor) || !canBeAttacked(actor)) continue;
    candidates.push({ id: actor.id, subject: { hp: actor.hp, fighting: actor.fighting !== undefined } });
  }
  const chosen = pickByWeakness(candidates);
  return chosen === undefined ? undefined : sim.get(chosen);
}

/* -------------------------------------------------------------------------- */
/* Assist                                                                      */
/* -------------------------------------------------------------------------- */

/** One mob wading into somebody else's fight. */
export interface AssistEvent {
  readonly helper: Mob;
  /** The ally it is coming to the aid of. */
  readonly ally: Actor;
  readonly foe: Actor;
}

/**
 * Mobs joining fights beside them.
 *
 * **Room-scoped, and that is the source's own limit rather than a simplification.**
 * `find_protector_target` scans `LOOP_THRU_PEOPLE(t_ch, ch)` — the people in the room — and looks no
 * further. §2.5's `assistRange`, a cry for help carrying across several rooms, is the *other* mechanism:
 * `ACT2_COMBAT_NEARBY`, which lives in a second action word the simple `.mob` record does not carry. So
 * the near half is built from real data and the far half waits for a record format we do not have, the
 * same wall `ACT2_NO_LURE` hit in Phase 10.
 *
 * The refusals are the source's, in its order: a mob already fighting does not go looking for another
 * fight, it must be able to *act*, and it must be able to **see** the foe — an assist into a dark room
 * against something it cannot make out would be a mob attacking a rumour.
 */
export function advanceAssists(
  sim: Simulation,
  scheduler: Scheduler,
  canSee: (mob: Mob, foe: Actor) => boolean,
): AssistEvent[] {
  const events: AssistEvent[] = [];

  for (const actor of sim.allActors()) {
    if (!isMob(actor) || !actor.aggro.assists) continue;
    // Already busy, or in no state to help. `IS_FIGHTING(ch) → return NULL` is the source's first line.
    if (actor.fighting !== undefined || !canEngage(actor)) continue;

    // Somebody in this room who is fighting, and whose opponent is a legitimate foe. Scanned rather than
    // read off a list, for the same reason the mercy rule scans: there is no fight object.
    for (const ally of sim.actorsIn(actor.roomId)) {
      if (ally.id === actor.id || ally.fighting === undefined) continue;
      // Mobs assist mobs. A mob wading in on a player's side would need a notion of allegiance that
      // nothing models — charm and grouping are Phases 18 and 20.
      if (!isMob(ally)) continue;
      const foe = sim.get(ally.fighting);
      if (!foe || foe.roomId !== actor.roomId || !canBeAttacked(foe)) continue;
      if (!canSee(actor, foe)) continue;
      if (!engage(scheduler, actor, foe)) continue;
      events.push({ helper: actor, ally, foe });
      break;
    }
  }

  return events;
}

/** Narrowings re-exported so a caller needs one import for combat. */
export { isMob, isPlayer, type Actor, type Mob, type Player };
