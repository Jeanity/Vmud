/**
 * Pursuit that closes — the pointer a fleeing mob leaves behind, and the gates on cashing it in.
 *
 * The wiring (marking on the flee outcome, firing on arrival) lives in `index.ts`; what is tested
 * here is every decision either half makes. The failure this feature exists to fix: `kill youth`
 * resolves by keyword and picks the freshest youth, so the wounded one that fled walked away from
 * every chase and a level-1 character could not land a kill on anything that flees.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { markPursuers, pursuitTarget } from './pursue.ts';
import type { Actor, Mob, Player } from './sim.ts';

let nextId = 1;

function player(over: Partial<Player> = {}): Player {
  return {
    id: nextId++,
    kind: 'player',
    name: 'Chaser',
    roomId: 100,
    hp: 22,
    status: 'normal',
    fighting: undefined,
    wasFighting: undefined,
    pursuing: undefined,
    ...over,
  } as Player;
}

function mob(over: Partial<Mob> = {}): Mob {
  return {
    id: nextId++,
    kind: 'mob',
    name: 'a kobold youth',
    roomId: 100,
    hp: 17,
    status: 'normal',
    fighting: undefined,
    wasFighting: undefined,
    ...over,
  } as Mob;
}

/** The one method `pursuitTarget` uses, backed by a map — no simulation needed. */
function lookup(...actors: Actor[]): { get(id: number): Actor | undefined } {
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  return { get: (id) => byId.get(id) };
}

const sees = () => true;
const blind = () => false;

describe('marking pursuers', () => {
  it('points everyone the fleeing mob escaped at the mob, by id', () => {
    const fleer = mob();
    const one = player({ wasFighting: fleer.id });
    const two = player({ wasFighting: fleer.id });
    // `changed` is clearEngagements' list: the fleer itself plus everyone whose pointer it broke.
    markPursuers(fleer, [fleer, one, two]);
    assert.equal(one.pursuing, fleer.id);
    assert.equal(two.pursuing, fleer.id);
  });

  it('marks nobody when a player flees — running away is not a claim on the kill', () => {
    const runner = player();
    const enemy = mob({ wasFighting: runner.id });
    markPursuers(runner, [runner, enemy]);
    assert.equal((enemy as Actor as Player).pursuing, undefined);
    assert.equal(runner.pursuing, undefined);
  });

  it('never marks a player who was not actually fighting the fleer', () => {
    const fleer = mob();
    const bystander = player({ wasFighting: undefined });
    markPursuers(fleer, [fleer, bystander]);
    assert.equal(bystander.pursuing, undefined);
  });
});

describe('closing the pursuit', () => {
  it('answers the quarry when it stands in the same room, visible and alive', () => {
    const quarry = mob({ roomId: 200 });
    const chaser = player({ roomId: 200, pursuing: quarry.id });
    assert.equal(pursuitTarget(lookup(quarry), chaser, sees), quarry);
  });

  it('keeps the pointer while the quarry is elsewhere — a chase can run for rooms', () => {
    const quarry = mob({ roomId: 300 });
    const chaser = player({ roomId: 200, pursuing: quarry.id });
    assert.equal(pursuitTarget(lookup(quarry), chaser, sees), undefined);
    assert.equal(chaser.pursuing, quarry.id, 'still chasing');
  });

  it('does not see through darkness — the same gate a typed kill passes', () => {
    // A mob that flees into an unlit room is gone. Answering it anyway would make pursuit a
    // wallhack, and the whole visibility system exists to prevent exactly that.
    const quarry = mob({ roomId: 200 });
    const chaser = player({ roomId: 200, pursuing: quarry.id });
    assert.equal(pursuitTarget(lookup(quarry), chaser, blind), undefined);
    assert.equal(chaser.pursuing, quarry.id, 'the claim survives; the sighting failed');
  });

  it('yields to a fight in progress', () => {
    const quarry = mob({ roomId: 200 });
    const other = mob({ roomId: 200 });
    const chaser = player({ roomId: 200, pursuing: quarry.id, fighting: other.id });
    assert.equal(pursuitTarget(lookup(quarry, other), chaser, sees), undefined);
  });

  it('clears the pointer when the quarry is dead or gone from the world', () => {
    // Distinct from "not here": a despawned or dying body can never be re-engaged, so keeping the
    // pointer would be a claim that can never fire.
    const chaser = player({ pursuing: 999 });
    assert.equal(pursuitTarget(lookup(), chaser, sees), undefined);
    assert.equal(chaser.pursuing, undefined);

    const dying = mob({ roomId: 100, status: 'dying' });
    const second = player({ pursuing: dying.id });
    assert.equal(pursuitTarget(lookup(dying), second, sees), undefined);
    assert.equal(second.pursuing, undefined);
  });

  it('does nothing at all for a player who is not chasing anything', () => {
    const idle = player();
    assert.equal(pursuitTarget(lookup(), idle, sees), undefined);
  });
});
