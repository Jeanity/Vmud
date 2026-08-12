/**
 * What a body is doing, and which clip says so — **the state machine, and it is pure.**
 *
 * §6-M7 asks for *"an `AnimationMixer` state machine (idle/walk/run/attack/hit/die) driven by the 3 s
 * round but interpolated at frame rate"*. The two halves of that sentence are two different objects
 * here, on purpose:
 *
 * - {@link BodyMotion} is a **pure reducer**. It holds a locomotion gait, an optional overlay and a
 *   death flag, takes events (a blow landed, a blow arrived, the body died) and a measured speed, and
 *   answers *which clip, looping or not, over what fade*. No `three` import, no mixer, no time source
 *   beyond the delta it is handed — so the whole of "does a critical knock you back and a normal blow
 *   not" is a table-driven unit test with no GPU and no scene in it.
 * - {@link BodyAnimator} is the twenty lines that push that answer into an `AnimationMixer`.
 *
 * ## The clip table
 *
 * Sixteen clips, eleven from *Universal Animation Library 1* and five from *2*, re-cut into two 2 MB
 * GLBs by `modelgen.buildAnimationLibrary`. Every one is used; nothing is loaded and never played.
 *
 * | State | Clip | Loop | Chosen by |
 * |---|---|---|---|
 * | idle | `Idle_Loop` | yes | speed below {@link WALK_SPEED} |
 * | idle, in a fight | `Sword_Idle` | yes | `EntityView.fighting` and a blade in the hand |
 * | idle, casting | `Spell_Simple_Idle_Loop` | yes | `EntityView.casting` — protocol 22's own field |
 * | walk | `Walk_Loop` | yes | {@link WALK_SPEED}..{@link JOG_SPEED} |
 * | jog | `Jog_Fwd_Loop` | yes | {@link JOG_SPEED}..{@link SPRINT_SPEED} |
 * | run | `Sprint_Loop` | yes | above {@link SPRINT_SPEED} — which is where a player at full tilt is |
 * | swing, armed | `Sword_Regular_A` / `_B` / `_C` | once | a blade or an axe in the main hand, rotating per blow |
 * | swing, otherwise | `Sword_Attack` | once | an empty hand, a torch, or a weapon the pack has no mesh for |
 * | cast / loose | `Spell_Simple_Shoot` | once | `attackResolved.swing === 'shoot'` |
 * | hit | `Hit_Chest` / `Hit_Head` | once | an ordinary blow, alternating so a beating is not one frame repeated |
 * | hit, hard | `Hit_Knockback` | once | `attackResolved.critical` |
 * | parried | `Sword_Block` | once | a blow that **missed** a body carrying a shield |
 * | dead | `Death01` | once, clamped | `died`, and it holds the last pose until `entityLeave` |
 *
 * **`Sword_Block` on a miss is the one entry that is an interpretation rather than a reading**, and it
 * is deliberate. `AttackOutcomeKind` reserves `block`, `parry` and `dodge` for Phase 19 and the server
 * cannot yet produce any of them, so a shield's animation would otherwise be loaded and never played.
 * A blow that came and did not land, against a body holding the only shield mesh in the game, is the
 * honest reading available today; when the real outcome lands the condition narrows to it.
 *
 * ## The 3 s round drives *when*, and nothing else
 *
 * Every overlay here starts on a message — `attackResolved`, `died` — and those arrive on the
 * server's own round boundary. Nothing in this file knows what a round is or how long one lasts, and
 * that is the point: `roundLengthFor` is data (`combat.ts`), haste will shorten it, and a state
 * machine holding a 3,000 would be the second copy of a number that is already allowed to change. The
 * mixer interpolates between the frames of whatever was started, at whatever rate the display runs.
 *
 * ## Speed is measured, not told
 *
 * There is no velocity on the wire. The gait comes from how far the body actually moved since the last
 * frame, which is right for three separate reasons: it works for the local player under prediction
 * (whose position is the predictor's, not the server's — §5 of the brief), it works for a remote body
 * easing toward its authoritative position, and it cannot disagree with what the eye sees, because it
 * *is* what the eye sees. Low-passed over {@link SPEED_SMOOTHING} so the ease-out at the end of a walk
 * does not flicker between two gaits on the way down.
 */

import { AnimationMixer, LoopOnce, LoopRepeat, type AnimationAction, type AnimationClip, type Object3D } from 'three';

import { PLAYER_SPEED, TILE_SIZE } from '@mygame/shared';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every clip name the machine can ask for — **the mirror of `modelgen.CHARACTER_CLIPS`**.
 *
 * Two lists and one check: `worldgen` owns the cut because it does the cutting, this owns the
 * vocabulary because it does the playing, and `characters.test.ts` asserts every name here is in the
 * generated manifest. A clip renamed upstream is then a failing test rather than a character frozen
 * mid-stride, which is `kit.test.ts`'s standing arrangement for `treeTexture`.
 */
export const CLIPS = [
  'Death01',
  'Hit_Chest',
  'Hit_Head',
  'Hit_Knockback',
  'Idle_Loop',
  'Jog_Fwd_Loop',
  'Spell_Simple_Idle_Loop',
  'Spell_Simple_Shoot',
  'Sprint_Loop',
  'Sword_Attack',
  'Sword_Block',
  'Sword_Idle',
  'Sword_Regular_A',
  'Sword_Regular_B',
  'Sword_Regular_C',
  'Walk_Loop',
] as const;

export type ClipName = (typeof CLIPS)[number];

/** The three swings the armed ladder rotates through, one per blow. */
export const SWING_LADDER: readonly ClipName[] = ['Sword_Regular_A', 'Sword_Regular_B', 'Sword_Regular_C'];

/** Metres a second, from the simulation's own pixel speed. `150 px/s / 32 px/m` = 4.6875 m/s. */
export const FULL_SPEED = PLAYER_SPEED / TILE_SIZE;

/**
 * The gait ladder, in metres a second — and the numbers are anchored on {@link FULL_SPEED}, not
 * invented.
 *
 * A player at full tilt crosses the ground at **4.69 m/s**, which is a run by any measure (a human
 * jog is about 3), so full speed is `Sprint_Loop` and the two slower gaits are not decoration: the
 * simulation only ever hands the *local* body 0 or full, but every **remote** body eases toward its
 * authoritative position at `EASE_FOLLOW` and therefore decays through the whole range on every stop.
 * So all four fire in ordinary play, which is the test of whether a ladder was worth having.
 */
export const WALK_SPEED = 0.25;
export const JOG_SPEED = FULL_SPEED * 0.4;
export const SPRINT_SPEED = FULL_SPEED * 0.77;

/**
 * Seconds the measured speed takes to close most of the gap to a new value.
 *
 * A remote body's ease is exponential, so its speed sweeps the whole ladder in about a third of a
 * second; without this the gait would change three times on the way down and read as a stumble. One
 * lerp a frame, and it is the only state this file keeps that is not a clip name.
 */
export const SPEED_SMOOTHING = 0.15;

/**
 * How fast a body turns, in radians a second — §6-M7's *"never snap"*, as a number.
 *
 * **10 rad/s, so a 180° about-face takes 0.31 s.** Chosen against the thing that actually produces
 * them: the simulation holds four headings (`space.yawOf`), so every turn on the wire is a multiple of
 * 90° arriving in one message, and the only question is how long the body takes to get there. A
 * quarter turn is 0.16 s — inside the 3 s round, faster than a walk step, and slow enough to read as a
 * turn rather than as a new pose.
 *
 * Shortest arc, always: `yawOf` returns `(-π, π]` precisely so `Sword_Regular_A` on a body that just
 * turned from north to east does not spin it the long way round once per fight.
 */
export const TURN_RATE = 10;

/** Move `from` toward `to` by at most `TURN_RATE x seconds`, the short way round. */
export function turnToward(from: number, to: number, seconds: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  const step = TURN_RATE * seconds;
  if (Math.abs(delta) <= step) return to;
  return from + Math.sign(delta) * step;
}

/* -------------------------------------------------------------------------- */
/* The reducer                                                                 */
/* -------------------------------------------------------------------------- */

/** What the body is standing still *doing*, when it is standing still. */
export type IdleKind = 'plain' | 'fighting' | 'casting';

/** What a body needs to know about itself to choose a motion. Everything here is on the wire. */
export interface MotionSubject {
  /** `EntityView.hands.main` — a `prop:` id, or nothing. Decides which swing plays. */
  readonly mainHand?: string;
  /** `EntityView.hands.off` — decides whether a miss reads as a block. */
  readonly offHand?: string;
  /** `EntityView.fighting !== undefined`. */
  readonly fighting?: boolean;
  /** `EntityView.casting`. */
  readonly casting?: boolean;
}

/** What the machine wants played, this frame. `undefined` overlay means "just the gait". */
export interface Motion {
  readonly gait: ClipName;
  readonly overlay?: ClipName;
  /** Crossfade into whatever changed, in seconds. */
  readonly fade: number;
  /** True once dead: the gait is frozen and {@link BodyAnimator} clamps the last frame. */
  readonly dead: boolean;
}

/** The two blades the pack has. A torch or an empty hand swings differently — see the table. */
const BLADED: ReadonlySet<string> = new Set(['prop:Sword_Bronze', 'prop:Axe_Bronze']);

const SHIELD = 'prop:Shield_Wooden';

/** Fades, in seconds. Gait changes are gentle; a swing has to start on the frame the blow landed. */
export const FADE_GAIT = 0.22;
export const FADE_GAIT_FAST = 0.16;
export const FADE_OVERLAY_IN = 0.1;
export const FADE_DEATH = 0.2;

/**
 * One body's motion, as a reducer over events and speed.
 *
 * Holds four numbers and two strings. No `three`, no DOM, no clock — {@link advance} is handed the
 * frame's own delta, exactly as `Wetness` and `PrecipFade` are, so a test can run a whole fight in a
 * loop and assert what was playing at 1.2 s.
 */
export class BodyMotion {
  private speed = 0;
  private overlay: ClipName | undefined;
  /** Seconds left of the overlay. It ends by running out, never by being interrupted by the gait. */
  private overlayLeft = 0;
  private swingAt = 0;
  /** Alternates `Hit_Chest` / `Hit_Head`, so being beaten on looks like being beaten on. */
  private hitAt = 0;
  private died = false;

  /** True from `died` until the body is released. The gait stops; the pose is held. */
  get dead(): boolean {
    return this.died;
  }

  /** The low-passed speed, metres a second — `__debug3d.bodies` reads it. */
  get metresPerSecond(): number {
    return this.speed;
  }

  /**
   * One frame: fold in how far the body actually moved, and age the overlay.
   *
   * `moved` is metres since the last call. Division by the frame's own seconds rather than by a fixed
   * step, because a 30 fps frame moves twice as far as a 60 fps one and the gait must not depend on
   * which machine is watching.
   */
  advance(seconds: number, moved: number): void {
    if (seconds > 0) {
      const instant = moved / seconds;
      // Exponential approach over the real frame, `entities.ease`'s discipline: a per-frame constant
      // would smooth twice as hard at 120 fps as at 60.
      const rate = 1 - Math.exp(-seconds / SPEED_SMOOTHING);
      this.speed += (instant - this.speed) * rate;
    }
    if (this.overlayLeft > 0) {
      this.overlayLeft -= seconds;
      if (this.overlayLeft <= 0) {
        this.overlayLeft = 0;
        this.overlay = undefined;
      }
    }
  }

  /**
   * This body threw a blow — `attackResolved` with `attacker === id`.
   *
   * The swing is chosen from what is in the hand rather than from `swing`'s verb, with one exception:
   * `'shoot'` means something left the hand, which is a spell or an arrow, and both read as
   * `Spell_Simple_Shoot`. Everything else is a body moving a weapon it is holding, and the *weapon* is
   * what decides how.
   */
  struck(subject: MotionSubject, swing: 'slash' | 'thrust' | 'shoot' | undefined, durationOf: (clip: ClipName) => number): void {
    if (this.died) return;
    const clip: ClipName =
      swing === 'shoot'
        ? 'Spell_Simple_Shoot'
        : subject.mainHand !== undefined && BLADED.has(subject.mainHand)
          ? (SWING_LADDER[this.swingAt++ % SWING_LADDER.length] ?? 'Sword_Attack')
          : 'Sword_Attack';
    this.play(clip, durationOf(clip));
  }

  /**
   * This body took a blow — `attackResolved` with `target === id`.
   *
   * A miss is not nothing: a shield-bearer plays the block, which is the only motion in the pack that
   * says *"that one did not get through"*. A miss against anybody else leaves the body doing whatever
   * it was doing, because flinching at a blow that never arrived is worse than not reacting.
   */
  tookBlow(
    subject: MotionSubject,
    hit: boolean,
    critical: boolean,
    durationOf: (clip: ClipName) => number,
  ): void {
    if (this.died) return;
    if (!hit) {
      if (subject.offHand === SHIELD) this.play('Sword_Block', durationOf('Sword_Block'));
      return;
    }
    const clip: ClipName = critical ? 'Hit_Knockback' : this.hitAt++ % 2 === 0 ? 'Hit_Chest' : 'Hit_Head';
    this.play(clip, durationOf(clip));
  }

  /** The body died. One way in, no way out — the corpse holds its last frame until `entityLeave`. */
  fell(durationOf: (clip: ClipName) => number): void {
    if (this.died) return;
    this.died = true;
    this.overlay = 'Death01';
    this.overlayLeft = durationOf('Death01');
  }

  /** Back to a living, still, unarmed body. Called when a rig is recycled onto a new entity. */
  reset(): void {
    this.speed = 0;
    this.overlay = undefined;
    this.overlayLeft = 0;
    this.swingAt = 0;
    this.hitAt = 0;
    this.died = false;
  }

  /** What should be playing, given what this body is and how fast it is going. */
  motion(subject: MotionSubject): Motion {
    if (this.died) return { gait: 'Death01', overlay: 'Death01', fade: FADE_DEATH, dead: true };
    const gait = gaitFor(this.speed, subject);
    return {
      gait,
      ...(this.overlay ? { overlay: this.overlay } : {}),
      fade: this.speed > WALK_SPEED ? FADE_GAIT_FAST : FADE_GAIT,
      dead: false,
    };
  }

  private play(clip: ClipName, duration: number): void {
    this.overlay = clip;
    // A zero-length clip would latch the overlay for ever; the shortest real one is `Hit_Chest` at
    // 0.333 s, so the floor is never reached in practice and exists so a missing clip cannot freeze a
    // body mid-swing.
    this.overlayLeft = Math.max(duration, 0.1);
  }
}

/**
 * The gait for a speed — and the three standing-still poses, which are the only place this function
 * looks at anything but the number.
 *
 * `casting` outranks `fighting`, because a caster in a fight is *both* and the wind-up is the thing
 * with a deadline: protocol 22 put `casting` on the view precisely so an observer can see the spell
 * coming, and a sword idle over the top of it would hide the tell.
 */
export function gaitFor(speed: number, subject: MotionSubject): ClipName {
  if (speed >= SPRINT_SPEED) return 'Sprint_Loop';
  if (speed >= JOG_SPEED) return 'Jog_Fwd_Loop';
  if (speed >= WALK_SPEED) return 'Walk_Loop';
  if (subject.casting) return 'Spell_Simple_Idle_Loop';
  if (subject.fighting && subject.mainHand !== undefined && BLADED.has(subject.mainHand)) return 'Sword_Idle';
  return 'Idle_Loop';
}

/* -------------------------------------------------------------------------- */
/* The mixer                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The twenty lines that turn a {@link Motion} into three.js actions.
 *
 * One mixer per body, which is what three requires — a mixer is bound to a root object and an action
 * caches a binding into that object's own bones. The **clips** are shared: an `AnimationClip` is
 * immutable keyframe data, so all 24 rigs play the same sixteen objects and the animation payload is
 * loaded once.
 *
 * The overlay is a second action at full weight rather than an additive layer, and that is a
 * deliberate simplification: three's additive blending wants a reference pose baked per clip
 * (`makeClipAdditive`), the UAL clips are whole-body motions rather than upper-body ones, and a MUD
 * character stops walking to swing. When there is a reason to swing while running, this is the seam.
 */
export class BodyAnimator {
  readonly mixer: AnimationMixer;
  private readonly clips: ReadonlyMap<string, AnimationClip>;
  private readonly actions = new Map<string, AnimationAction>();
  private gait: ClipName | undefined;
  private overlay: ClipName | undefined;

  constructor(root: Object3D, clips: ReadonlyMap<string, AnimationClip>) {
    this.mixer = new AnimationMixer(root);
    this.clips = clips;
  }

  /** Seconds a clip runs, for {@link BodyMotion}'s overlay countdown. Zero when it is not loaded. */
  durationOf = (clip: ClipName): number => this.clips.get(clip)?.duration ?? 0;

  /** Apply a motion and advance the mixer. One call a frame, from `entities.render`. */
  apply(motion: Motion, seconds: number): void {
    const wanted = motion.overlay ?? motion.gait;
    if (motion.overlay !== this.overlay) {
      this.overlay = motion.overlay;
      this.crossFade(wanted, motion.overlay ? FADE_OVERLAY_IN : motion.fade, motion.dead);
    } else if (!motion.overlay && motion.gait !== this.gait) {
      this.crossFade(motion.gait, motion.fade, false);
    }
    if (!motion.overlay) this.gait = motion.gait;
    this.mixer.update(seconds);
  }

  /** Stop everything and forget the bindings — called when a rig is recycled onto another entity. */
  reset(): void {
    this.mixer.stopAllAction();
    this.gait = undefined;
    this.overlay = undefined;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot() as Object3D);
    this.actions.clear();
  }

  private crossFade(to: ClipName, fade: number, clamp: boolean): void {
    const next = this.action(to);
    if (!next) return;
    const loop = clamp || ONE_SHOT.has(to);
    next.reset();
    next.setLoop(loop ? LoopOnce : LoopRepeat, loop ? 1 : Infinity);
    // **The corpse holds its pose.** Without this the death clip snaps back to the first frame and the
    // body stands up again at the end of the fight, which is the single most obviously wrong thing a
    // renderer can do with `Death01`.
    next.clampWhenFinished = loop;
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.fadeIn(fade);
    for (const [name, action] of this.actions) {
      if (name !== to && action.isRunning()) action.fadeOut(fade);
    }
    next.play();
  }

  private action(clip: ClipName): AnimationAction | undefined {
    const held = this.actions.get(clip);
    if (held) return held;
    const source = this.clips.get(clip);
    if (!source) return undefined;
    const action = this.mixer.clipAction(source);
    this.actions.set(clip, action);
    return action;
  }
}

/** Clips that play once and stop. Everything else loops. */
const ONE_SHOT: ReadonlySet<string> = new Set([
  'Death01',
  'Hit_Chest',
  'Hit_Head',
  'Hit_Knockback',
  'Spell_Simple_Shoot',
  'Sword_Attack',
  'Sword_Block',
  'Sword_Regular_A',
  'Sword_Regular_B',
  'Sword_Regular_C',
]);
