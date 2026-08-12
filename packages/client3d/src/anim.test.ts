/**
 * The state machine, with no mixer, no scene and no clock but the one it is handed.
 *
 * That is the whole reason {@link BodyMotion} is a reducer: *"does a critical knock you back and an
 * ordinary blow not"* and *"does a corpse stay down"* are questions about a table, and a table can be
 * asserted in a millisecond. What is **not** tested here is whether three's `AnimationMixer` blends
 * two actions correctly, because that is three's test to have written.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BodyMotion,
  CLIPS,
  FULL_SPEED,
  JOG_SPEED,
  SPRINT_SPEED,
  SWING_LADDER,
  TURN_RATE,
  WALK_SPEED,
  gaitFor,
  turnToward,
  type ClipName,
} from './anim.ts';

/** Every clip is 0.4 s long, so an overlay's countdown is predictable. */
const durationOf = (): number => 0.4;

const BARE = {};
const SWORD = { mainHand: 'prop:Sword_Bronze' };
const SHIELDED = { mainHand: 'prop:Sword_Bronze', offHand: 'prop:Shield_Wooden' };

/** Runs the machine forward at 60 fps over a constant speed, and answers what is playing at the end. */
function run(motion: BodyMotion, seconds: number, metresPerSecond: number, subject = BARE): ReturnType<BodyMotion['motion']> {
  const step = 1 / 60;
  for (let t = 0; t < seconds; t += step) motion.advance(step, metresPerSecond * step);
  return motion.motion(subject);
}

describe('the gait ladder', () => {
  it('puts a player at full tilt in a run, and gives the two slower gaits real ground', () => {
    // 4.6875 m/s is what `PLAYER_SPEED / TILE_SIZE` actually is, and it is a run by any measure.
    assert.ok(Math.abs(FULL_SPEED - 150 / 32) < 1e-9);
    assert.equal(gaitFor(FULL_SPEED, BARE), 'Sprint_Loop');
    assert.equal(gaitFor(0, BARE), 'Idle_Loop');
    assert.equal(gaitFor(WALK_SPEED, BARE), 'Walk_Loop');
    assert.equal(gaitFor(JOG_SPEED, BARE), 'Jog_Fwd_Loop');
    assert.equal(gaitFor(SPRINT_SPEED, BARE), 'Sprint_Loop');
    // The bands are ordered and non-overlapping, which is what makes the ladder a ladder.
    assert.ok(WALK_SPEED < JOG_SPEED && JOG_SPEED < SPRINT_SPEED && SPRINT_SPEED < FULL_SPEED);
  });

  it('stands a body in the pose its situation calls for, and casting outranks fighting', () => {
    assert.equal(gaitFor(0, { ...SWORD, fighting: true }), 'Sword_Idle');
    assert.equal(gaitFor(0, { ...SWORD, fighting: true, casting: true }), 'Spell_Simple_Idle_Loop');
    assert.equal(gaitFor(0, { casting: true }), 'Spell_Simple_Idle_Loop');
    // A fighter with no blade has no sword idle to stand in.
    assert.equal(gaitFor(0, { fighting: true }), 'Idle_Loop');
    assert.equal(gaitFor(0, { mainHand: 'prop:Torch_Metal', fighting: true }), 'Idle_Loop');
  });

  it('smooths the measured speed instead of switching gait on one fast frame', () => {
    const motion = new BodyMotion();
    // One frame of full-speed movement must not put a standing body into a sprint: the low-pass has a
    // 0.15 s time constant, so a single 16 ms frame moves it about a tenth of the way.
    motion.advance(1 / 60, FULL_SPEED / 60);
    assert.equal(motion.motion(BARE).gait, 'Walk_Loop');
    // Held, it arrives.
    assert.equal(run(motion, 0.6, FULL_SPEED).gait, 'Sprint_Loop');
    // A body genuinely moving at a jog settles at a jog — five time constants is 0.75 s.
    assert.equal(run(new BodyMotion(), 0.8, JOG_SPEED * 1.1).gait, 'Jog_Fwd_Loop');
    // And decays back down the ladder rather than snapping to idle: a body that stops dead is still
    // walking a tenth of a second later, which is what the ease-out of a remote body looks like.
    const stopping = new BodyMotion();
    run(stopping, 0.8, FULL_SPEED);
    stopping.advance(0.1, 0);
    assert.notEqual(stopping.motion(BARE).gait, 'Idle_Loop');
    stopping.advance(1, 0);
    assert.equal(stopping.motion(BARE).gait, 'Idle_Loop');
  });
});

describe('what a blow looks like', () => {
  it('rotates the three-swing ladder for an armed body and repeats the generic swing for a bare one', () => {
    const armed = new BodyMotion();
    const played: (ClipName | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      armed.struck(SWORD, undefined, durationOf);
      played.push(armed.motion(SWORD).overlay);
      armed.advance(0.5, 0);
    }
    assert.deepEqual(played, [...SWING_LADDER, SWING_LADDER[0]]);

    const bare = new BodyMotion();
    bare.struck(BARE, undefined, durationOf);
    assert.equal(bare.motion(BARE).overlay, 'Sword_Attack');
    // A torch is not a blade — it swings like a fist.
    const torch = new BodyMotion();
    torch.struck({ mainHand: 'prop:Torch_Metal' }, undefined, durationOf);
    assert.equal(torch.motion(BARE).overlay, 'Sword_Attack');
  });

  it('sends anything that leaves the hand through the same cast motion', () => {
    const motion = new BodyMotion();
    motion.struck(SWORD, 'shoot', durationOf);
    // Even holding a sword: `shoot` means the *attack* left the body, and the pack has one such clip.
    assert.equal(motion.motion(SWORD).overlay, 'Spell_Simple_Shoot');
  });

  it('ends an overlay by running out, and falls back to the gait underneath it', () => {
    const motion = new BodyMotion();
    motion.struck(SWORD, undefined, durationOf);
    assert.ok(motion.motion(SWORD).overlay);
    motion.advance(0.39, 0);
    assert.ok(motion.motion(SWORD).overlay, 'still swinging at 0.39 s of a 0.4 s clip');
    motion.advance(0.02, 0);
    assert.equal(motion.motion(SWORD).overlay, undefined);
    assert.equal(motion.motion(SWORD).gait, 'Idle_Loop');
  });
});

describe('what being hit looks like', () => {
  it('alternates the two ordinary flinches so a beating is not one frame repeated', () => {
    const motion = new BodyMotion();
    const played: (ClipName | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      motion.tookBlow(BARE, true, false, durationOf);
      played.push(motion.motion(BARE).overlay);
      motion.advance(0.5, 0);
    }
    assert.deepEqual(played, ['Hit_Chest', 'Hit_Head', 'Hit_Chest', 'Hit_Head']);
  });

  it('knocks a body back only on a critical', () => {
    const motion = new BodyMotion();
    motion.tookBlow(BARE, true, true, durationOf);
    assert.equal(motion.motion(BARE).overlay, 'Hit_Knockback');
  });

  it('blocks a miss with a shield and ignores a miss without one', () => {
    const shielded = new BodyMotion();
    shielded.tookBlow(SHIELDED, false, false, durationOf);
    assert.equal(shielded.motion(SHIELDED).overlay, 'Sword_Block');
    const bare = new BodyMotion();
    bare.tookBlow(SWORD, false, false, durationOf);
    assert.equal(bare.motion(SWORD).overlay, undefined, 'flinching at a blow that never arrived is worse');
  });
});

describe('dying', () => {
  it('holds the last pose and refuses everything afterwards', () => {
    const motion = new BodyMotion();
    motion.fell(durationOf);
    const dead = motion.motion(SWORD);
    assert.equal(dead.gait, 'Death01');
    assert.equal(dead.overlay, 'Death01');
    assert.ok(dead.dead);
    // The clip is 0.4 s and the corpse is still down at ten seconds — the overlay expiring does not
    // resurrect it, because `motion()` short-circuits on `died` before it looks at the gait.
    motion.advance(10, 0);
    assert.equal(motion.motion(SWORD).gait, 'Death01');
    // …and it does not swing, flinch or walk.
    motion.struck(SWORD, undefined, durationOf);
    motion.tookBlow(SWORD, true, true, durationOf);
    assert.equal(run(motion, 1, FULL_SPEED, SWORD).gait, 'Death01');
  });

  it('comes back to life only through a reset, which is what recycling a rig does', () => {
    const motion = new BodyMotion();
    motion.fell(durationOf);
    motion.reset();
    assert.ok(!motion.dead);
    assert.equal(motion.motion(BARE).gait, 'Idle_Loop');
    assert.equal(motion.metresPerSecond, 0);
  });
});

describe('turning', () => {
  it('takes the short way round and never the long one', () => {
    // From just west of north to just east of north: 0.2 rad, not 6.08.
    const from = 0.1;
    const to = -0.1;
    const stepped = turnToward(from, to, 0.001);
    assert.ok(stepped < from, `turned the wrong way: ${stepped}`);
    // The far side of the circle is reached across ±π rather than through zero.
    const across = turnToward(3.0, -3.0, 0.01);
    assert.ok(across > 3.0, `should have gone up through +pi, got ${across}`);
  });

  it('arrives exactly, and takes the documented time to do it', () => {
    assert.equal(turnToward(0, 0.001, 1), 0.001, 'a step longer than the gap lands on the gap');
    // 10 rad/s: a 180 degree about-face in 0.314 s, a quarter turn in 0.157 s.
    let yaw = 0;
    let elapsed = 0;
    while (Math.abs(yaw - Math.PI) > 1e-6 && elapsed < 2) {
      yaw = turnToward(yaw, Math.PI, 1 / 240);
      elapsed += 1 / 240;
    }
    assert.ok(Math.abs(elapsed - Math.PI / TURN_RATE) < 0.01, `${elapsed.toFixed(3)} s for a half turn`);
  });
});

describe('the clip vocabulary', () => {
  it('names sixteen clips, all distinct, and every one is reachable', () => {
    assert.equal(new Set(CLIPS).size, CLIPS.length);
    assert.equal(CLIPS.length, 16);
    const reached = new Set<string>();
    // Locomotion and the three idles.
    for (const speed of [0, WALK_SPEED, JOG_SPEED, SPRINT_SPEED]) reached.add(gaitFor(speed, BARE));
    reached.add(gaitFor(0, { ...SWORD, fighting: true }));
    reached.add(gaitFor(0, { casting: true }));
    // Every overlay.
    const swing = new BodyMotion();
    for (let i = 0; i < 3; i++) {
      swing.struck(SWORD, undefined, durationOf);
      reached.add(swing.motion(SWORD).overlay!);
      swing.advance(0.5, 0);
    }
    swing.struck(BARE, undefined, durationOf);
    reached.add(swing.motion(BARE).overlay!);
    swing.advance(0.5, 0);
    swing.struck(BARE, 'shoot', durationOf);
    reached.add(swing.motion(BARE).overlay!);
    swing.advance(0.5, 0);
    for (const critical of [false, true, false]) {
      swing.tookBlow(BARE, true, critical, durationOf);
      reached.add(swing.motion(BARE).overlay!);
      swing.advance(0.5, 0);
    }
    swing.tookBlow(SHIELDED, false, false, durationOf);
    reached.add(swing.motion(SHIELDED).overlay!);
    swing.advance(0.5, 0);
    swing.fell(durationOf);
    reached.add(swing.motion(BARE).overlay!);
    // **Nothing is loaded and never played.** A clip in the cut list that no state can reach is 130 KB
    // of keyframes the player downloads for nothing, and this is the assertion that says so.
    assert.deepEqual([...reached].sort(), [...CLIPS].sort());
  });
});
