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

import { EntityLayer, EASE_FOLLOW, EASE_PREDICTED, SNAP_DISTANCE, ease } from './entities.ts';
import { cellOriginTiles, metresOfPixel } from './frame.ts';
import { CameraRig } from './rig.ts';
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
    const layer = new EntityLayer(world.scene, world.pool);
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

    layer.render((px, py) => world.groundAt(px, py));
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
    const layer = new EntityLayer(world.scene, world.pool);
    const start = centreOf(world, 1, 1);
    layer.selfId = 7;
    layer.upsert({ id: 7, kind: 'player', name: 'Greybox', sprite: 'player', x: start.x, y: start.y, facing: 'north' });
    world.update(start.x, start.y);
    world.setSeen(bitsToBase64(createBitset(grid.width * grid.height)));
    layer.render((px, py) => world.groundAt(px, py));

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
});
