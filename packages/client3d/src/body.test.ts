/**
 * Composing a body, and giving it back — the rig and the pool's first per-entity family.
 *
 * Built on stand-ins rather than on the real import, `KitSet.standIn`'s own argument: what is under
 * test is the *assembly* — that every part binds to one skeleton by name, that a garment culls the
 * region it replaces, that a prop hangs off the right bone, and that a rig comes back whole — and none
 * of that is a statement about the vendor's vertices. The vendor's vertices are `characters.test.ts`'s
 * and `skin.test.ts`'s.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Scene, type Bone, type Mesh, type SkinnedMesh } from 'three';

import { yawOf } from '@mygame/shared';

import { EntityLayer } from './entities.ts';

import { acquireRig, type BodyRig } from './body.ts';
import { CharacterSet } from './characters.ts';
import { BODY_POOL_SIZE, BODY_RIG_BYTES, ScenePool } from './pool.ts';
import { MODEL_FORWARD_OFFSET } from './body.ts';

const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'characters');

/** Just enough of a glTF node to walk the rest hierarchy. */
interface RestNode {
  readonly name?: string;
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly children?: readonly number[];
}

/**
 * A joint's rest position in model space, composing rotation as well as translation.
 *
 * The composition is the point. This rig's bones run along their own local Y (it is Unreal's
 * mannequin naming — `pelvis`, `foot_l`, `ball_l`), so adding translations alone answers a question
 * about bone *lengths* and says nothing about where anything is. That mistake reads a foot as being
 * directly above its ankle, which is exactly plausible enough to be believed.
 */
function restPositionOf(nodes: readonly RestNode[], name: string): [number, number, number] | undefined {
  const rotate = (q: readonly number[], v: readonly number[]): [number, number, number] => {
    const [x, y, z, w] = q as [number, number, number, number];
    const [vx, vy, vz] = v as [number, number, number];
    // v + 2q_v x (q_v x v + w v)
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  };
  let found: [number, number, number] | undefined;
  const walk = (index: number, origin: [number, number, number], q: readonly number[]): void => {
    const node = nodes[index];
    if (!node) return;
    const local = rotate(q, node.translation ?? [0, 0, 0]);
    const here: [number, number, number] = [origin[0] + local[0], origin[1] + local[1], origin[2] + local[2]];
    const nq = compose(q, node.rotation ?? [0, 0, 0, 1]);
    if (node.name === name) found = here;
    for (const child of node.children ?? []) walk(child, here, nq);
  };
  const compose = (a: readonly number[], b: readonly number[]): number[] => {
    const [ax, ay, az, aw] = a as [number, number, number, number];
    const [bx, by, bz, bw] = b as [number, number, number, number];
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  };
  const parented = new Set<number>();
  nodes.forEach((n) => (n.children ?? []).forEach((c) => parented.add(c)));
  nodes.forEach((_, i) => {
    if (!parented.has(i) && !found) walk(i, [0, 0, 0], [0, 0, 0, 1]);
  });
  return found;
}

/** The armature, abbreviated to one joint per region plus a hand for each side. */
const JOINTS = [
  'root',
  'pelvis',
  'spine_01',
  'spine_02',
  'spine_03',
  'neck_01',
  'Head',
  'clavicle_l',
  'upperarm_l',
  'lowerarm_l',
  'hand_l',
  'clavicle_r',
  'upperarm_r',
  'lowerarm_r',
  'hand_r',
  'thigh_l',
  'calf_l',
  'foot_l',
  'thigh_r',
  'calf_r',
  'foot_r',
];

const STEMS = [
  'Superhero_Male_FullBody',
  'Superhero_Female_FullBody',
  'Male_Peasant_Body',
  'Male_Peasant_Arms',
  'Male_Peasant_Legs',
  'Male_Peasant_Feet',
  'Sword_Bronze',
  'Shield_Wooden',
];

function setUp(): { pool: ScenePool; set: CharacterSet; scene: Scene } {
  const pool = new ScenePool();
  const set = new CharacterSet();
  set.standIn(pool, JOINTS, STEMS);
  return { pool, set, scene: new Scene() };
}

/** Every `SkinnedMesh` hanging directly off a rig's group — the body and its garments. */
function skinnedOf(rig: BodyRig): SkinnedMesh[] {
  return rig.group.children.filter((child) => (child as SkinnedMesh).isSkinnedMesh) as SkinnedMesh[];
}

/** Every plain `Mesh` parented to a bone — the props. */
function heldOf(rig: BodyRig): { bone: string; mesh: Mesh }[] {
  const out: { bone: string; mesh: Mesh }[] = [];
  rig.group.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || (mesh as SkinnedMesh).isSkinnedMesh) return;
    // holder -> bone
    const bone = mesh.parent?.parent as Bone | undefined;
    out.push({ bone: bone?.name ?? '?', mesh });
  });
  return out;
}

describe('which way a body faces', () => {
  it('turns the mesh by the heading plus the vendor offset, not by the heading alone', () => {
    const { pool, set } = setUp();
    const rig = acquireRig(set, pool, 'base:Superhero_Male_FullBody')!;
    rig.dress('base:Superhero_Male_FullBody', [], undefined, undefined);
    // First call snaps to the wire's yaw; the drawn rotation is that heading, turned to suit a mesh
    // whose rest forward is +Z. Without the offset every character walks backwards — see
    // `MODEL_FORWARD_OFFSET`, and the owner who reported it.
    rig.update(0.016, 0, 0, { gait: 'idle' } as never);
    assert.equal(rig.drawnYaw, 0, 'the body’s own heading is the wire’s');
    assert.ok(Math.abs(rig.group.rotation.y - Math.PI) < 1e-9, 'and the mesh is turned to face it');
    pool.dispose();
  });

  it('measures the pack’s rest forward off the asset, so a vendor change fails here', (t) => {
    // The bug this pins was a *stated assumption* — `space.ts` claims these meshes are -Z-forward —
    // and no amount of reasoning about the renderer would have caught it. Only the file knows.
    const gltf = join(MODELS_DIR, 'superhero-male-full-body', 'model.gltf');
    if (!existsSync(gltf)) {
      t.skip('the character models have not been generated — see .gitignore for the modelgen command');
      return;
    }
    const nodes = (JSON.parse(readFileSync(gltf, 'utf8')) as { nodes: RestNode[] }).nodes;
    const foot = restPositionOf(nodes, 'foot_l');
    const ball = restPositionOf(nodes, 'ball_l');
    assert.ok(foot && ball, 'the Unreal-named rig should carry foot_l and ball_l');
    // Toes forward of the ankle, and the sign of that is the whole of `MODEL_FORWARD_OFFSET`.
    const forwardZ = ball![2] - foot![2];
    assert.ok(
      Math.abs(forwardZ) > Math.abs(ball![0] - foot![0]),
      'the toes should lead along Z, not X — the rig is not oriented as this test assumes',
    );
    assert.ok(forwardZ > 0, 'the pack faces +Z; if this fails the offset below is stale');
    assert.equal(MODEL_FORWARD_OFFSET, Math.PI, 'a +Z mesh needs exactly half a turn');
  });
});

describe('assembling a body', () => {
  it('clones the whole armature by name and binds every mesh to the one skeleton', () => {
    const { pool, set, scene } = setUp();
    const rig = acquireRig(set, pool, 'base:Superhero_Male_FullBody')!;
    scene.add(rig.group);
    rig.dress(
      'base:Superhero_Male_FullBody',
      [
        { slot: 'torso', part: 'outfit:Male_Peasant_Body' },
        { slot: 'arms', part: 'outfit:Male_Peasant_Arms' },
      ],
      undefined,
      undefined,
    );

    const meshes = skinnedOf(rig);
    assert.equal(meshes.length, 3, 'the culled base plus two garments');
    const skeleton = meshes[0]!.skeleton;
    for (const mesh of meshes) {
      assert.equal(mesh.skeleton, skeleton, 'a part bound to a skeleton of its own would not follow the body');
      // The bind matrix is explicitly identity and never the no-argument form, which would have called
      // `calculateInverses()` and overwritten the base body's bind pose with the current one.
      assert.ok(mesh.bindMatrix.equals(meshes[0]!.bindMatrix));
      assert.equal(mesh.frustumCulled, false, 'a bind-pose sphere cannot contain a sword swing');
      assert.equal(mesh.castShadow, true, 'a body with no shadow floats');
    }
    assert.deepEqual(skeleton.bones.map((bone) => bone.name), JOINTS, 'the clone lost or reordered a joint');
    assert.equal(skeleton.bones.length, JOINTS.length);
    // The clone is a clone: writing the rig's bones must not touch the template's.
    const template = set.body('Superhero_Male_FullBody')!;
    for (let i = 0; i < skeleton.bones.length; i++) {
      assert.notEqual(skeleton.bones[i], template.bones[i], `${JOINTS[i]} was shared with the template`);
    }
    pool.dispose();
  });

  it('rebuilds only when the kit actually changed', () => {
    const { pool, set } = setUp();
    const rig = acquireRig(set, pool, 'base:Superhero_Male_FullBody')!;
    const gear = [{ slot: 'torso', part: 'outfit:Male_Peasant_Body' }];
    rig.dress('base:Superhero_Male_FullBody', gear, undefined, undefined);
    const before = skinnedOf(rig);
    rig.dress('base:Superhero_Male_FullBody', [{ slot: 'torso', part: 'outfit:Male_Peasant_Body' }], undefined, undefined);
    assert.deepEqual(skinnedOf(rig), before, 'an identical kit must not rebuild the meshes');
    rig.dress('base:Superhero_Male_FullBody', [...gear, { slot: 'legs', part: 'outfit:Male_Peasant_Legs' }], undefined, undefined);
    assert.equal(skinnedOf(rig).length, before.length + 1);
    pool.dispose();
  });

  it('hangs the main hand off hand_r and the off hand off hand_l', () => {
    const { pool, set } = setUp();
    const rig = acquireRig(set, pool, 'base:Superhero_Male_FullBody')!;
    rig.dress('base:Superhero_Male_FullBody', undefined, 'prop:Sword_Bronze', 'prop:Shield_Wooden');
    const held = heldOf(rig);
    assert.equal(held.length, 2);
    assert.deepEqual(held.map((entry) => entry.bone).sort(), ['hand_l', 'hand_r']);
    // A prop is rigid and rides its bone's matrix. A `SkinnedMesh` here would draw at the origin,
    // because a weapon's geometry carries no `skinIndex` at all.
    for (const { mesh } of held) assert.ok(!(mesh as SkinnedMesh).isSkinnedMesh);
    // Taking the shield away leaves the sword where it was.
    rig.dress('base:Superhero_Male_FullBody', undefined, 'prop:Sword_Bronze', undefined);
    assert.deepEqual(heldOf(rig).map((entry) => entry.bone), ['hand_r']);
    pool.dispose();
  });

  it('draws nothing for a hand the pack has no mesh for, rather than the wrong thing', () => {
    const { pool, set } = setUp();
    const rig = acquireRig(set, pool, 'base:Superhero_Male_FullBody')!;
    rig.dress('base:Superhero_Male_FullBody', undefined, 'prop:Warhammer_Of_Nothing', undefined);
    assert.deepEqual(heldOf(rig), []);
    pool.dispose();
  });

  it('answers nothing for a creature, which is what keeps the capsule path alive', () => {
    const { pool, set } = setUp();
    assert.equal(acquireRig(set, pool, 'creature:wolf'), undefined);
    assert.equal(acquireRig(set, pool, 'base:Nobody_Here'), undefined);
    pool.dispose();
  });
});

describe('the body pool', () => {
  it('recycles a rig rather than minting a second, and keeps the ledger straight', () => {
    const { pool, set } = setUp();
    const first = acquireRig(set, pool, 'base:Superhero_Male_FullBody')!;
    assert.equal(pool.snapshot().rigsCreated, 1);
    assert.equal(pool.snapshot().rigsLive, 1);
    pool.releaseBody('Superhero_Male_FullBody', first);
    assert.equal(pool.snapshot().rigsLive, 0);
    assert.equal(pool.snapshot().rigsFree, 1);
    const second = acquireRig(set, pool, 'base:Superhero_Male_FullBody')!;
    assert.equal(second, first, 'the free list gave the same rig back');
    assert.equal(pool.snapshot().rigsCreated, 1, 'a recycled rig must not mint');
    assert.equal(pool.snapshot().rigBytes, BODY_RIG_BYTES);
    pool.dispose();
  });

  it('keeps the two sexes on their own lists', () => {
    const { pool, set } = setUp();
    const male = acquireRig(set, pool, 'base:Superhero_Male_FullBody')!;
    pool.releaseBody('Superhero_Male_FullBody', male);
    const female = acquireRig(set, pool, 'base:Superhero_Female_FullBody')!;
    assert.notEqual(female, male, 'a female body must not be handed a male skeleton');
    assert.equal(pool.snapshot().rigsCreated, 2);
    pool.dispose();
  });

  it('parks a rig clean, so the next entity does not inherit the last one’s clothes', () => {
    const { pool, set, scene } = setUp();
    const rig = acquireRig(set, pool, 'base:Superhero_Male_FullBody')!;
    scene.add(rig.group);
    rig.dress('base:Superhero_Male_FullBody', [{ slot: 'torso', part: 'outfit:Male_Peasant_Body' }], 'prop:Sword_Bronze', undefined);
    rig.motion.fell(() => 1);
    assert.ok(rig.motion.dead);
    pool.releaseBody('Superhero_Male_FullBody', rig);
    assert.equal(rig.group.parent, null, 'a parked rig is off the scene graph');
    assert.deepEqual(skinnedOf(rig), []);
    assert.deepEqual(heldOf(rig), []);
    assert.ok(!rig.motion.dead, 'a recycled corpse must stand up');
    // …and re-dressing it from scratch works, which is what a re-acquire does.
    const again = acquireRig(set, pool, 'base:Superhero_Male_FullBody')!;
    again.dress('base:Superhero_Male_FullBody', [{ slot: 'legs', part: 'outfit:Male_Peasant_Legs' }], undefined, undefined);
    assert.equal(skinnedOf(again).length, 2);
    pool.dispose();
  });

  it('refuses past the cap and says so, rather than growing without a bound', () => {
    const { pool, set } = setUp();
    const rigs: BodyRig[] = [];
    for (let i = 0; i < BODY_POOL_SIZE; i++) {
      const rig = acquireRig(set, pool, 'base:Superhero_Male_FullBody');
      assert.ok(rig, `rig ${i} of the cap was refused`);
      rigs.push(rig);
    }
    assert.equal(acquireRig(set, pool, 'base:Superhero_Male_FullBody'), undefined, 'the cap did not hold');
    const snapshot = pool.snapshot();
    assert.equal(snapshot.rigsCreated, BODY_POOL_SIZE);
    assert.equal(snapshot.rigHighWater, BODY_POOL_SIZE);
    // The refusal is counted, because a non-zero value is the world saying the cap was measured
    // against the wrong rooms — not a bug, a report.
    assert.equal(snapshot.rigsRefused, 1);
    // Give one back and the next caller is served again, from the free list rather than by minting.
    pool.releaseBody('Superhero_Male_FullBody', rigs[0]!);
    assert.ok(acquireRig(set, pool, 'base:Superhero_Male_FullBody'));
    assert.equal(pool.snapshot().rigsCreated, BODY_POOL_SIZE, 'the cap released and re-took without minting');
    pool.dispose();
  });

  it('charges the ledger for rigs and folds them into the total', () => {
    const { pool, set } = setUp();
    const before = pool.snapshot();
    assert.equal(before.rigsCreated, 0, 'the body family is the one thing here that is not pre-warmed');
    acquireRig(set, pool, 'base:Superhero_Male_FullBody');
    acquireRig(set, pool, 'base:Superhero_Female_FullBody');
    const after = pool.snapshot();
    assert.equal(after.rigBytes, 2 * BODY_RIG_BYTES);
    assert.equal(after.bytes - before.bytes, 2 * BODY_RIG_BYTES, 'a rig must show up in the total');
    // 65 x 16 floats of bone matrices plus a 20x20 RGBA-float bone texture, which is what three sizes
    // for 65 bones. Ten and a half kilobytes a body, 253 KB across the cap.
    assert.equal(BODY_RIG_BYTES, 65 * 16 * 4 + 20 * 20 * 4 * 4);
    assert.equal(BODY_RIG_BYTES, 10_560);
    assert.equal(BODY_POOL_SIZE * BODY_RIG_BYTES, 253_440);
    pool.dispose();
  });

  it('survives a churn of entities without the rig ledger climbing', () => {
    // The body half of `traversal.test.ts`'s flat-ledger property, in miniature: two hundred bodies
    // enter and leave in waves and the pool mints only as many rigs as were ever alive at once.
    const { pool, set } = setUp();
    let live: BodyRig[] = [];
    for (let wave = 0; wave < 20; wave++) {
      for (const rig of live) pool.releaseBody(wave % 2 === 0 ? 'Superhero_Male_FullBody' : 'Superhero_Female_FullBody', rig);
      live = [];
      const stem = wave % 2 === 0 ? 'Superhero_Female_FullBody' : 'Superhero_Male_FullBody';
      for (let i = 0; i < 10; i++) {
        const rig = acquireRig(set, pool, `base:${stem}`);
        if (rig) live.push(rig);
      }
    }
    const snapshot = pool.snapshot();
    assert.equal(snapshot.rigsLive, live.length);
    assert.equal(snapshot.rigsLive + snapshot.rigsFree, snapshot.rigsCreated, 'a rig was leaked or freed twice');
    // Ten of each sex ever alive at once, so twenty rigs however many waves ran.
    assert.equal(snapshot.rigsCreated, 20, `minted ${snapshot.rigsCreated} rigs over 200 arrivals`);
    assert.equal(snapshot.rigsRefused, 0);
    pool.dispose();
  });
});

describe('a body that arrived before its pack did', () => {
  it('starts as a capsule and becomes a person on the frame the pack lands', () => {
    // `characters.load` is not awaited (`main.ts`, and the same argument the trees and the kit make),
    // so a session genuinely does start with real entities in a real room and no meshes behind them.
    // Without the generation check in `render` they would stay capsules until they next changed
    // clothes or the player next walked through a door.
    const pool = new ScenePool();
    const set = new CharacterSet();
    const scene = new Scene();
    const layer = new EntityLayer(scene, pool, set);
    const view = {
      id: 1,
      kind: 'player' as const,
      name: 'Early',
      sprite: 'human',
      x: 0,
      y: 0,
      facing: 'north' as const,
      model: 'base:Superhero_Male_FullBody',
      yaw: 0,
    };
    layer.upsert(view);
    assert.equal(layer.rigged, 0, 'nothing is staged yet, so it must draw as a capsule');
    layer.render(1 / 60, () => 0);
    assert.equal(layer.rigged, 0);

    set.standIn(pool, JOINTS, STEMS);
    layer.render(1 / 60, () => 0);
    assert.equal(layer.rigged, 1, 'the pack landed and the capsule did not become a person');
    // …and it does not re-body every frame after that.
    const created = pool.snapshot().rigsCreated;
    layer.render(1 / 60, () => 0);
    layer.render(1 / 60, () => 0);
    assert.equal(pool.snapshot().rigsCreated, created);
    pool.dispose();
  });

  it('re-derives the yaw on every move, or a walking body freezes the way it arrived', () => {
    // The moonwalk, in one assertion. `entityMoved` is the high-frequency message and predates M7a:
    // it carries the cardinal `facing` and no `yaw`. The rig reads `view.yaw` every frame, so a body
    // whose move updated only `facing` kept the orientation it entered view with — a mob's spawn
    // 'south' — while walking off in every other direction.
    const pool = new ScenePool();
    const set = new CharacterSet();
    set.standIn(pool, JOINTS, STEMS);
    const layer = new EntityLayer(new Scene(), pool, set);
    layer.upsert({
      id: 7,
      kind: 'mob' as const,
      name: 'a kobold youth',
      sprite: 'human',
      x: 0,
      y: 0,
      facing: 'south' as const,
      model: 'base:Superhero_Male_FullBody',
      yaw: Math.PI,
    });

    layer.moved(7, 100, 0, 'east');
    const east = layer.viewOf(7);
    assert.equal(east?.facing, 'east');
    assert.equal(east?.yaw, yawOf('east'), 'the yaw must travel with the facing it came from');

    layer.moved(7, 100, -100, 'north');
    assert.equal(layer.viewOf(7)?.yaw, yawOf('north'));
    // And the pair can never disagree, which is the invariant rather than the four cases.
    for (const facing of ['north', 'south', 'east', 'west'] as const) {
      layer.moved(7, 0, 0, facing);
      const view = layer.viewOf(7);
      assert.ok(view, 'the body should still be held');
      assert.equal(view.yaw, yawOf(view.facing), `${facing} disagreed with its own yaw`);
    }
    pool.dispose();
  });

  it('keeps a creature on the capsule path however long it waits', () => {
    const pool = new ScenePool();
    const set = new CharacterSet();
    const layer = new EntityLayer(new Scene(), pool, set);
    layer.upsert({
      id: 2,
      kind: 'mob',
      name: 'a wolf',
      sprite: 'male/wolf',
      x: 0,
      y: 0,
      facing: 'north',
      model: 'creature:wolf',
      yaw: 0,
    });
    set.standIn(pool, JOINTS, STEMS);
    layer.render(1 / 60, () => 0);
    assert.equal(layer.rigged, 0, 'no monster pack exists, so a wolf stays a tinted pill');
    assert.equal(pool.snapshot().rigsCreated, 0, 'and it must not have taken a rig to find that out');
    assert.equal(pool.snapshot().rigsRefused, 0, 'nor be counted as a refusal');
    pool.dispose();
  });

  it('gives a rig back when the entity leaves, and takes one again when it returns', () => {
    const pool = new ScenePool();
    const set = new CharacterSet();
    set.standIn(pool, JOINTS, STEMS);
    const layer = new EntityLayer(new Scene(), pool, set);
    const view = {
      id: 3,
      kind: 'mob' as const,
      name: 'a sentry',
      sprite: 'human',
      x: 0,
      y: 0,
      facing: 'north' as const,
      model: 'base:Superhero_Male_FullBody',
      yaw: 0,
    };
    layer.upsert(view);
    assert.equal(pool.snapshot().rigsLive, 1);
    layer.remove(3);
    assert.equal(pool.snapshot().rigsLive, 0);
    assert.equal(pool.snapshot().rigsFree, 1);
    layer.upsert(view);
    assert.equal(pool.snapshot().rigsCreated, 1, 'the return should have come off the free list');
    // A Place change takes everyone with it.
    layer.clear(false);
    assert.equal(pool.snapshot().rigsLive, 0);
    pool.dispose();
  });
});
