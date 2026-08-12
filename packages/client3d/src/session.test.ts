/**
 * A whole session, headless: arrive, stream, see, open a door, walk, be corrected.
 *
 * The other test files each hold one piece still and prod it. This one drives the pieces the way
 * `main.ts` does — `setPlace` then `setSeen` then `applyDoor` then `step` then `render` — because
 * every bug this milestone can actually ship is a wiring bug, and a wiring bug is invisible to a
 * file that only ever calls one function.
 *
 * It runs against the synthetic fixture rather than `data/world`, so it is one of the four files
 * that check the invariants on a checkout that has never generated a world.
 *
 * `three` builds object graphs perfectly well in Node with no `WebGLRenderer` anywhere, which is the
 * property that makes all of this assertable at all — see `pool.ts`'s note on why the ledger rather
 * than `renderer.info.memory` is what CI checks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { InstancedMesh, Material } from 'three';

import {
  PLAYER_SPEED,
  ROOM_TILES,
  TILE_SIZE,
  Tile,
  isWalkable,
  tileAt,
  type EntityView,
} from '@mygame/shared';
import { bitsToBase64, createBitset, bitsetAdd } from '@mygame/shared/vision.ts';

import { CharacterSet } from './characters.ts';
import { EntityLayer, EASE_FOLLOW, EASE_PREDICTED, SNAP_DISTANCE, ease } from './entities.ts';
import { cellOriginTiles, metresOfPixel } from './frame.ts';
import { CAMERA_DISTANCE_MAX, CAMERA_PITCH_MIN, CameraRig } from './rig.ts';
import { sampleZone } from './fixture.ts';
import { World3D } from './world3d.ts';

/** Material names of everything currently in the scene — the key `prototypes.materialKey` made. */
function materialsInScene(world: World3D): string[] {
  const names: string[] = [];
  for (const child of world.scene.children) {
    const mesh = child as Partial<InstancedMesh>;
    if (typeof mesh.count !== 'number' || mesh.count === 0) continue;
    const material = mesh.material as Material | undefined;
    if (material?.name) names.push(material.name);
  }
  return names;
}

/**
 * The fog-of-war multiplier a named material is currently drawn with.
 *
 * Reads the wrapper's `instanceColor` — which *is* the per-chunk uniform (see `fogOfWar.ts`), so this
 * is the same three floats the fragment shader multiplies the diffuse by, not a proxy for them.
 */
function tintOf(world: World3D, materialName: string): [number, number, number] | undefined {
  for (const child of world.scene.children) {
    const mesh = child as Partial<InstancedMesh>;
    if (typeof mesh.count !== 'number' || mesh.count === 0) continue;
    if ((mesh.material as Material | undefined)?.name !== materialName) continue;
    const array = mesh.instanceColor?.array;
    if (!array) continue;
    return [array[0] ?? 1, array[1] ?? 1, array[2] ?? 1];
  }
  return undefined;
}

/** Simulation pixels at the centre of a room's block. */
function centreOf(world: World3D, cellX: number, cellY: number): { x: number; y: number } {
  const frame = world.frame!;
  const origin = cellOriginTiles(frame, cellX, cellY);
  return { x: (origin.tx + ROOM_TILES / 2) * TILE_SIZE, y: (origin.ty + ROOM_TILES / 2) * TILE_SIZE };
}

describe('a session, end to end', () => {
  it('arrives, streams the neighbourhood and stands the camera on the ground', () => {
    const zone = sampleZone();
    const world = new World3D();
    const rig = new CameraRig(16 / 9);
    world.setPlace(zone, 0);

    const here = centreOf(world, 1, 1);
    world.update(here.x, here.y);
    // Four rooms in the fixture, all inside a 7x5 window, so all four are built and nothing else.
    assert.equal(world.chunksLoaded, 4);
    const { levels, faded } = world.chunkLevels();
    assert.deepEqual(levels, { 0: 4 });
    assert.equal(faded, 0, 'no `seen` has arrived, so nothing is dimmed yet');

    const y = world.groundAt(here.x, here.y);
    rig.follow(metresOfPixel(here.x), y, metresOfPixel(here.y));
    assert.ok(rig.camera.position.y > y, 'the camera is above the ground it was pointed at');
    world.dispose();
  });

  it('moves a room through all three fog states as the server and the character say so', () => {
    const zone = sampleZone();
    const world = new World3D();
    world.setPlace(zone, 0);
    const grid = world.grid!;
    const here = centreOf(world, 1, 1);
    world.update(here.x, here.y);

    // Before any snapshot everything is drawn present, deliberately: a world that boots black and
    // resolves a tick later reads as a bug rather than as fog.
    assert.deepEqual(world.fogCensus(), { unseen: 0, remembered: 0, visible: 4 });

    // Nothing seen at all, and nowhere to stand: every chunk is unexplored.
    world.setSeen(bitsToBase64(createBitset(grid.width * grid.height)));
    assert.deepEqual(world.fogCensus(), { unseen: 4, remembered: 0, visible: 0 });
    const dark = tintOf(world, 'ground|field');
    assert.ok(dark);
    assert.ok(dark.every((channel) => channel < 0.35), `unexplored ground is tinted ${dark.join(', ')}`);

    // Light one room's centre tile — the test `stateOf` runs — and only that room is remembered.
    const origin = grid.roomOrigins.get(3)!;
    const centre = (origin.ty + 4) * grid.width + (origin.tx + 4);
    world.addSeen([centre]);
    assert.deepEqual(world.fogCensus(), { unseen: 3, remembered: 1, visible: 0 });

    // Stand in it. Room 3's exits reach rooms 2 and 4, so three of the four light up; room 1 is a
    // barrier-only cell with no exit anywhere and stays unexplored.
    world.setHere(3);
    assert.deepEqual(world.fogCensus(), { unseen: 1, remembered: 0, visible: 3 });
    // Room 2 is the only forest cell, so its ground names one chunk unambiguously — and it is lit
    // because room 3 has an exit west to it, which is the whole of the "immediate neighbours" rule.
    assert.deepEqual(tintOf(world, 'ground|forest'), [1, 1, 1], 'a room you can walk into must be untinted');

    // A delta that changes nothing must not churn the pool — and a state change must not either,
    // because a repaint is three floats and not a rebuild.
    const before = world.ledger();
    world.addSeen([centre]);
    world.setHere(3);
    assert.deepEqual(world.ledger(), before);
    world.dispose();
  });

  it('opens a door in the collision grid and in the geometry, together', () => {
    const zone = sampleZone();
    const world = new World3D();
    world.setPlace(zone, 0);
    const grid = world.grid!;
    world.update(centreOf(world, 1, 1).x, centreOf(world, 1, 1).y);

    // The fixture ships room 3's east door shut, so the grid has an unwalkable door tile and the
    // scene has a leaf.
    const origin = grid.roomOrigins.get(3)!;
    const doorTx = origin.tx + ROOM_TILES + 1;
    const doorTy = origin.ty + 4;
    assert.equal(tileAt(grid, doorTx, doorTy), Tile.Door);
    assert.ok(!isWalkable(tileAt(grid, doorTx, doorTy)));
    assert.ok(materialsInScene(world).includes('door'));
    assert.ok(!materialsInScene(world).includes('doorOpen'));

    world.applyDoor(3, 'east', false);
    assert.equal(tileAt(grid, doorTx, doorTy), Tile.DoorOpen);
    assert.ok(isWalkable(tileAt(grid, doorTx, doorTy)), 'prediction would walk into a tile the server allows');
    assert.ok(materialsInScene(world).includes('doorOpen'));
    assert.ok(!materialsInScene(world).includes('door'));

    // Both sides of the doorway agree — room 4 holds the same door from the west.
    world.applyDoor(3, 'east', true);
    assert.equal(tileAt(grid, doorTx, doorTy), Tile.Door);
    assert.equal(materialsInScene(world).filter((n) => n === 'door').length, 2, 'both rooms draw their leaf');
    world.dispose();
  });

  it('predicts, reconciles and snaps with the constants the 2D client uses', () => {
    const zone = sampleZone();
    const world = new World3D();
    world.setPlace(zone, 0);
    const layer = new EntityLayer(world.scene, world.pool, new CharacterSet());
    const start = centreOf(world, 1, 1);

    const view: EntityView = {
      id: 7,
      kind: 'player',
      name: 'Greybox',
      sprite: 'player',
      x: start.x,
      y: start.y,
      facing: 'north',
    };
    layer.selfId = 7;
    layer.upsert(view);

    // One tenth of a second of walking east, and then — in the *same* frame, which is the ordering
    // being pinned here — the pull back toward the last authoritative position, which has not moved
    // because no server update has arrived. Predict, then reconcile, exactly as `scene.ts` does.
    layer.step(0.1, world.grid, { x: 1, y: 0 }, true);
    const body = layer.body(7)!;
    const predicted = start.x + PLAYER_SPEED * 0.1;
    const settled = predicted + (start.x - predicted) * ease(EASE_PREDICTED, 0.1);
    assert.ok(Math.abs(body.x - settled) < 1e-9, `${body.x} vs ${settled}`);
    assert.ok(body.x > start.x, 'the prediction still won the frame');
    assert.equal(body.y, start.y);

    // A refused posture predicts nothing at all, however hard the key is held: with no prediction
    // to nudge, the only motion left is the pull *back* toward where the server says the body is.
    const held = body.x;
    layer.step(0.1, world.grid, { x: 1, y: 0 }, false);
    assert.ok(body.x < held, 'a seated character must not slide away from the server');
    assert.ok(Math.abs(body.x - held) < SNAP_DISTANCE);
    const followed = held + (start.x - held) * ease(EASE_FOLLOW, 0.1);
    assert.ok(Math.abs(body.x - followed) < 1e-9, 'an unpredicted body follows at the brisk rate');

    // Past `SNAP_DISTANCE` the correction is a teleport, not an ease.
    body.serverX = start.x + 400;
    body.serverY = start.y;
    layer.step(0.016, world.grid, { x: 0, y: 0 }, true);
    assert.equal(body.x, body.serverX);
    assert.equal(layer.teleported, true, 'a whole room of drift is a teleport');

    // Inside it, the follow rate is the 2D client's, compounded over the real frame time.
    body.x = body.serverX - 10;
    layer.step(0.016, world.grid, { x: 0, y: 0 }, true);
    const expected = body.serverX - 10 + 10 * ease(EASE_FOLLOW, 0.016);
    assert.ok(Math.abs(body.x - expected) < 1e-9, `${body.x} vs ${expected}`);
    assert.equal(layer.teleported, false);

    // And a remote body eases at the same rate without ever being predicted.
    layer.upsert({ ...view, id: 9, x: start.x, y: start.y });
    const other = layer.body(9)!;
    other.serverX = start.x + 20;
    layer.step(0.016, world.grid, { x: 1, y: 0 }, true);
    assert.ok(Math.abs(other.x - (start.x + 20 * ease(EASE_FOLLOW, 0.016))) < 1e-9);

    layer.render(0.016, (px: number, py: number) => world.groundAt(px, py));
    assert.equal(layer.count, 2);
    world.dispose();
  });

  it('returns everything to the pool on a Place change, and takes nothing new', () => {
    const zone = sampleZone();
    const world = new World3D();
    world.setPlace(zone, 0);
    world.update(centreOf(world, 1, 1).x, centreOf(world, 1, 1).y);
    const busy = world.ledger();
    assert.ok(busy.wrappersLive > 0);

    for (let round = 0; round < 25; round++) {
      world.setPlace(zone, 0);
      assert.equal(world.chunksLoaded, 0, 'an arrival drops every chunk');
      assert.equal(world.ledger().wrappersLive, 0);
      world.update(centreOf(world, 1, 1).x, centreOf(world, 1, 1).y);
      assert.equal(world.chunksLoaded, 4);
      assert.equal(world.ledger().wrappersLive, busy.wrappersLive);
    }
    const after = world.ledger();
    assert.equal(after.wrappersCreated, busy.wrappersCreated, 'twenty-five arrivals minted a wrapper');
    assert.equal(after.bytes, busy.bytes);
    assert.equal(after.acquires - after.releases, after.wrappersLive);
    world.dispose();
  });

  it('spends transparency on the level below and on nothing else', () => {
    // M3 drew an unexplored room with the *faded* materials, which said the same thing as "you are
    // looking at the floor beneath you". M4 separates them, and this is the wiring assertion that
    // they stayed separate: fog of war is a colour, the vertical policy is an alpha, and a Place with
    // one level therefore contains no transparent material at all however little of it has been seen.
    const zone = sampleZone();
    const world = new World3D();
    world.setPlace(zone, 0);
    const grid = world.grid!;
    const bits = createBitset(grid.width * grid.height);
    const lit = grid.roomOrigins.get(3)!;
    bitsetAdd(bits, (lit.ty + 4) * grid.width + (lit.tx + 4));
    world.update(centreOf(world, 1, 1).x, centreOf(world, 1, 1).y);
    world.setSeen(bitsToBase64(bits));

    assert.ok(world.fogCensus().unseen > 0, 'the fixture should have unexplored rooms here');
    assert.deepEqual(
      materialsInScene(world).filter((name) => name.endsWith('|dim')),
      [],
      'unexplored ground took a transparent material — that is the level-below register',
    );
    assert.equal(world.chunkLevels().faded, 0);
    world.dispose();
  });

  it('never tints a body, whatever the room it is standing in', () => {
    const zone = sampleZone();
    const world = new World3D();
    world.setPlace(zone, 0);
    const grid = world.grid!;
    const layer = new EntityLayer(world.scene, world.pool, new CharacterSet());
    const start = centreOf(world, 1, 1);
    layer.selfId = 7;
    layer.upsert({ id: 7, kind: 'player', name: 'Greybox', sprite: 'player', x: start.x, y: start.y, facing: 'north' });
    world.update(start.x, start.y);
    world.setSeen(bitsToBase64(createBitset(grid.width * grid.height)));
    layer.render(0.016, (px: number, py: number) => world.groundAt(px, py));

    assert.deepEqual(world.fogCensus(), { unseen: 4, remembered: 0, visible: 0 });
    // A character is not terrain. In an unexplored room the one thing that must stay legible is the
    // person standing in it, and nothing in the repaint path reaches these two wrappers.
    assert.deepEqual(tintOf(world, 'self'), [1, 1, 1]);
    world.dispose();
  });

  it('flags a portal ring for bloom and takes the flag back off when the wrapper is recycled', () => {
    // The pooled-wrapper hazard, asserted: the free list is LIFO, so the very next chunk to ask for a
    // wrapper gets the one the portal was drawn with. A selection left on it would bloom a ground
    // slab, intermittently, in whichever room happened to load next.
    const zone = sampleZone();
    const world = new World3D();
    const selected = new Set<object>();
    world.setGlowSet({ add: (o) => selected.add(o), delete: (o) => selected.delete(o) });
    world.setPlace(zone, 0);
    world.update(centreOf(world, 1, 1).x, centreOf(world, 1, 1).y);

    // Room 4's east exit is the fixture's portal, and it is the only one.
    assert.equal(selected.size, 1, 'the portal ring never reached the bloom selection');
    for (const mesh of selected) {
      assert.equal(((mesh as InstancedMesh).material as Material).name, 'portal');
    }
    world.setPlace(zone, 0);
    assert.equal(selected.size, 0, 'a released wrapper stayed flagged and will bloom as something else');
    world.dispose();
  });

  it('knows which rooms have a roof over them, so the weather can stop at the door', () => {
    const zone = sampleZone();
    const world = new World3D();
    world.setPlace(zone, 0);
    world.update(centreOf(world, 1, 1).x, centreOf(world, 1, 1).y);
    world.setHere(3);
    assert.equal(world.roofed, false, 'room 3 is a field');
    world.setHere(4);
    assert.equal(world.roofed, true, 'room 4 is `inside` and flagged `indoors`');
    world.dispose();
  });

  it('carries a moved rig to the fade bands and the shadow volume in one call — M6', () => {
    /*
     * The seam `main.ts` drives on every wheel notch and every resize, exercised the way this file
     * exercises everything: through the two objects rather than through either one's own unit test.
     * `rig.test.ts` proves the derivations and `prototypes.test.ts` proves the pool's write; what is
     * left, and what a wiring bug would live in, is whether `setCameraFrame` actually reaches both.
     */
    const world = new World3D();
    const rig = new CameraRig(16 / 9);
    world.setCameraFrame(rig.ground());
    const home = { fade: world.pool.fadeBands(), shadow: { ...world.night.extents } };
    // The far corner of the clamp: the frame more than doubles in depth, so both must follow.
    rig.distance = CAMERA_DISTANCE_MAX;
    rig.pitch = CAMERA_PITCH_MIN;
    world.setCameraFrame(rig.ground());
    const wide = { fade: world.pool.fadeBands(), shadow: { ...world.night.extents } };

    assert.ok(wide.fade.grass[0] > home.fade.grass[1], 'the undergrowth still fades where it used to');
    assert.ok(wide.shadow.width > home.shadow.width * 1.4, 'the shadow volume stayed the old size');
    assert.ok(wide.shadow.depth > home.shadow.depth * 1.8);
    // And the moon's orthographic camera actually took the new box, rather than the field being set
    // and the refit waiting for a frame that has not happened yet.
    assert.ok(world.night.fit.right - world.night.fit.left > 2 * wide.shadow.width, 'the fit is stale');

    rig.reset();
    world.setCameraFrame(rig.ground());
    assert.deepEqual({ ...world.pool.fadeBands() }, { ...home.fade }, 'coming home did not restore the band');
    assert.deepEqual({ ...world.night.extents }, home.shadow);
    world.dispose();
  });

  it('turns the shadow box with the yaw and leaves the fade bands alone — M8', () => {
    /*
     * The other seam `main.ts` drives, and it is driven *per frame* while a follow eases, so what it
     * must not do matters as much as what it must. `setCameraYaw` turns the shadow volume and
     * re-asks which wall the camera is behind; it must not touch the undergrowth's fade, which is a
     * function of view depth and cannot change when only the yaw does.
     */
    const world = new World3D();
    const rig = new CameraRig(16 / 9);
    world.setCameraFrame(rig.ground(), rig.pitch, rig.yawRadians);
    const fade = world.pool.fadeBands();
    const extents = { ...world.night.extents };
    const flat = world.night.fit.right - world.night.fit.left;

    rig.yaw = 45;
    world.setCameraYaw(rig.yawRadians);
    assert.deepEqual({ ...world.pool.fadeBands() }, { ...fade }, 'a yaw moved the undergrowth’s fade band');
    // The box is the same *size* — its extents are the camera's own axes — and a different shape in
    // the light's basis, which is the proof it actually turned rather than being re-applied.
    assert.deepEqual({ ...world.night.extents }, extents, 'the box grew instead of turning');
    assert.ok(Math.abs(world.night.fit.right - world.night.fit.left - flat) > 1, 'the fit ignored the yaw');
    world.dispose();
  });

  it('rebuilds the near wall when the camera orbits past a quadrant, and only then', () => {
    /*
     * **The affordability argument, checked rather than asserted in prose.** M6 declined to rebuild
     * on a camera move because a wheel notch is a per-frame event; M8 has to, because the wall that
     * fades depends on where the camera stands. What makes it affordable is that only chunks under
     * the *open* lid can care — `open` is `roofOpen && openSides.has(dir)` — so out of doors the whole
     * thing is one identity comparison, and indoors it is the one building the player is inside.
     *
     * Driven through a real Place with a roofed room, and counted by the pool's own churn: a rebuild
     * is a release and an acquire, so `wrappersLive` returning to the same number while `wrappersFree`
     * has been dipped into is the signature. What is asserted here is the *cheap* half — that a yaw
     * inside one octant does nothing at all — because that is the half that runs sixty times a second.
     */
    const world = new World3D();
    world.setPlace(sampleZone(), 0);
    const here = centreOf(world, 2, 1);
    world.update(here.x, here.y);
    // Room 4 is the `inside`, `indoors` one; standing in it takes its lid off and opens its near wall.
    world.setHere(4);
    const rig = new CameraRig(16 / 9);
    world.setCameraFrame(rig.ground(), rig.pitch, rig.yawRadians);
    const before = world.ledger().wrappersCreated;

    // A degree of drift inside the same octant: the set is the same object, so nothing is rebuilt and
    // nothing is minted. This is the per-frame path of a follow ease.
    for (let i = 1; i <= 30; i++) {
      rig.yaw = i * 0.05;
      world.setCameraYaw(rig.yawRadians);
    }
    assert.equal(world.ledger().wrappersCreated, before, 'a small orbit minted wrappers');

    // The lid really is off, or none of this proves anything: room 4 is the `inside`/`indoors` one and
    // standing in it opens its group, which is the set of chunks the rebuild walks.
    assert.equal(world.roofGroup, 4, 'the player is not under a lid, so no wall could fade either way');
    const live = world.ledger().wrappersLive;

    // A quarter turn changes which wall is in the way, and the building the player is under is rebuilt
    // — a release and an acquire, so the pool still mints nothing and the live count comes back to
    // where it was. (*What* the rebuild draws differently is `interior.test.ts`'s sweep, which reads
    // `planInterior` directly; the village modules are GLBs and a headless world has none, so the
    // scene here is `chunkPlan`'s grey box either way.)
    rig.yaw = -90;
    world.setCameraYaw(rig.yawRadians);
    assert.equal(world.ledger().wrappersCreated, before, 'the rebuild minted instead of recycling');
    assert.equal(world.ledger().wrappersLive, live, 'the rebuild leaked or dropped a wrapper');
    assert.ok(world.chunksLoaded > 0, 'the walk unloaded the world instead of rebuilding it');
    world.dispose();
  });
});
