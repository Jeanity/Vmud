/**
 * The 3D fields on the wire — M7a, the server half.
 *
 * `appearance.test.ts` in `@mygame/shared` proves the mapping. This proves the three things only the
 * server can be asked:
 *
 * 1. **`viewOf` fills them, and changes nothing else.** The whole deviation from `PLAN-3d-migration.md`
 *    §6-M7 is that this slice is additive, so the claim worth pinning is not that `model` appeared but
 *    that *every field the 2D client reads is byte-identical to what it was*. A regression here is the
 *    Phaser client breaking, which is exactly what the deviation exists to prevent.
 * 2. **A kit change reaches the body.** `afterKitChange` → `syncEntityState` → `sim.viewOf(actor)` is
 *    the seam every wear and remove already passes through — see the note on that test for what this
 *    can and cannot reach.
 * 3. **No body in the shipped world draws an id nothing staged.** The sweep, over the real
 *    `data/world/spawns` with the real `mobs.json` overlaid, the way `nearby.test.ts` walks the real
 *    Kobold Settlement rather than a fixture.
 */

import assert from 'node:assert/strict';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  BASE_PREFIX,
  CREATURE_PREFIX,
  appearanceOf,
  bodyScaleFor,
  boundsOf,
  drawnHeightOf,
  everyGearPartId,
  everyHairId,
  everyModelId,
  makeRng,
  raceScaleFor,
  wearsOutfits,
  yawOf,
  type Item,
  type MobTemplate,
  type Room,
  type RoomId,
  type Zone,
} from '@mygame/shared';

import { applyMobOverride, loadMobOverrides, MOBS_FILE } from './mob-overrides.ts';
import { Simulation } from './sim.ts';
import { SPAWNS_DIR } from './spawns.ts';
import { GameWorld } from './world.ts';

const MANIFEST: ReadonlySet<string> = new Set([...everyModelId(), ...everyGearPartId()]);
const HAIR_MANIFEST: ReadonlySet<string> = new Set(everyHairId());

const room = (id: number): Room => ({
  id: id as RoomId,
  zone: 900,
  name: 'A Room',
  pos: { x: 0, y: 0, z: 0 },
  sector: 'inside',
  exits: {},
});

const rooms = [room(90001)];
const zone: Zone = { id: 900, name: 'Test', rooms, bounds: boundsOf(rooms) };

function makeSim() {
  const sim = new Simulation(new GameWorld([zone], { zone: 900, room: 90001 as RoomId }));
  return { sim, player: sim.spawn('Mannequin', makeRng(1)) };
}

const item = (id: string, name: string): Item => ({ id, name, ac: 0, size: 1 });

/** One mob template, shared by the three tests that need a body to dress. */
const sentry = (): MobTemplate => ({
  vnum: 97018,
  keywords: ['sentry'],
  name: 'a sentry',
  room: 'A sentry stands watch here.',
  level: 3,
  hp: '1d1+9',
  sprite: 'muscular/human',
  aggro: { disposition: 'passive', clauses: [], reactionMs: 2000, remembers: true, sentinel: false, assists: false },
  pursuit: { tier: 'sentinel', trackRooms: 0, giveUpMs: 0, respectsSafeRooms: true, staysInZone: true, opensDoors: true },
  wimpyAt: 0,
  experience: 10,
  combat: { armourClass: 10, damage: { count: 1, sides: 4, bonus: 0 }, attackBonus: 1, roundMs: 3000 },
});

/* -------------------------------------------------------------------------- */
/* The view                                                                     */
/* -------------------------------------------------------------------------- */

describe('the 3D fields on an entity view', () => {
  it('carries a model, gear and a yaw for a player', () => {
    const { sim, player } = makeSim();
    const view = sim.viewOf(player);
    assert.equal(view.model, `${BASE_PREFIX}Superhero_Male_FullBody`);
    assert.ok((view.gear ?? []).length > 0, 'a fresh character rolls a starter kit and wears it');
    assert.equal(view.yaw, yawOf(player.facing));
    for (const part of view.gear ?? []) assert.ok(MANIFEST.has(part.part), `${part.part} is not staged`);
  });

  it('leaves `sprite` exactly as it was, because the 2D client still reads it', () => {
    // The deviation in one assertion. §6-M7 replaces this field; M7a does not, because character
    // creation and `charAdopt` live only in the Phaser client and breaking it strands new characters.
    const { sim, player } = makeSim();
    assert.equal(sim.viewOf(player).sprite, 'human');
    assert.equal(sim.viewOf(player).sprite, player.sprite);
  });

  it('adds six keys and disturbs nothing else', () => {
    // **The unknown-field safety test, the shape the `sky` message set.** A client that has never
    // heard of `model`, `gear`, `yaw`, `hands` — or, since the hair slice, `hair` and `scale` — must
    // see the message it saw yesterday, and the honest way to check that is to delete the new keys and
    // compare the whole rest of the payload, not to read the fields one at a time and trust the eye.
    const { sim, player } = makeSim();
    const view = sim.viewOf(player);
    const { model, gear, yaw, hands, hair, scale, ...asThe2dClientSeesIt } = view;
    assert.ok(model !== undefined && yaw !== undefined, 'the new fields must actually be present');
    // `scale` is absent on a player, who is always adult — the field only appears where it says
    // something, which is the whole reason it is optional.
    assert.equal(scale, undefined);
    void hair;
    // A fresh character's starter kit always rolls a main-hand weapon, and three of the four roll a
    // blade or an axe — so this is present far more often than not, and its absence would mean the
    // hand read never happened rather than that the roll came up a club.
    void hands;
    assert.deepEqual(Object.keys(asThe2dClientSeesIt).sort(), [
      'facing', 'healthFraction', 'id', 'kind', 'level', 'name', 'posture', 'sprite', 'status', 'wearing', 'x', 'y',
    ]);
    // And nothing in that remainder is a reference into the new data: a round trip through JSON is
    // what the wire does anyway, and it must not throw or lose a field.
    assert.deepEqual(JSON.parse(JSON.stringify(asThe2dClientSeesIt)), asThe2dClientSeesIt);
    assert.equal(gear, view.gear);
  });

  it('puts what is wielded in the hands, off the same equipment read', () => {
    // M7b. `wearing.mainHand` has been on the wire since 15a and is not enough on its own: for 98% of
    // the catalogue's weapons it is `obj:1234`. `handsOf` reads `Item.weaponClass` off the same
    // `equipped` the `wearing` record was built from — one read, so the two cannot disagree.
    const { sim, player } = makeSim();
    player.equipped = {
      mainHand: { ...item('broadsword', 'a notched broadsword'), slot: 'mainHand', weaponClass: 5 },
      offHand: { ...item('shield', 'a battered kite shield'), slot: 'offHand' },
    };
    const view = sim.viewOf(player);
    assert.deepEqual(view.hands, { main: 'prop:Sword_Bronze', off: 'prop:Shield_Wooden' });
    // …and the 2D vocabulary for the same two slots is untouched.
    assert.equal(view.wearing?.['mainHand'], 'broadsword');
    assert.equal(view.wearing?.['offHand'], 'shield');
  });

  it('leaves a hand empty rather than filling it with the wrong thing', () => {
    const { sim, player } = makeSim();
    player.equipped = { mainHand: { ...item('iron_mace', 'a pitted iron mace'), slot: 'mainHand', weaponClass: 6 } };
    const view = sim.viewOf(player);
    assert.equal(view.hands, undefined, 'a mace has no mesh and must not become a sword');
    assert.equal(view.wearing?.['mainHand'], 'iron_mace', 'and the 2D client still draws its own mace');
  });

  it('lights a hand that is holding a light', () => {
    const { sim, player } = makeSim();
    player.equipped = {
      mainHand: { ...item('obj:7', 'a guttering torch'), slot: 'mainHand', light: { radius: 3 } },
    };
    assert.deepEqual(sim.viewOf(player).hands, { main: 'prop:Torch_Metal' });
  });

  it('empties the hands the moment the weapon comes off, through the same resync', () => {
    // The eyes-on half of this is *"wield a sword, watch it appear"*, and the path is the one
    // `afterKitChange` already drives: -> `syncEntityState` -> `viewOf` -> `entityUpdate`. What can be
    // pinned headlessly is that the payload follows the equipment, both ways.
    const { sim, player } = makeSim();
    player.equipped = { mainHand: { ...item('dagger', 'a notched dagger'), slot: 'mainHand', weaponClass: 2 } };
    assert.equal(sim.viewOf(player).hands?.main, 'prop:Sword_Bronze');
    player.equipped = {};
    assert.equal(sim.viewOf(player).hands, undefined);
  });



  it('turns the yaw with the facing, all four ways', () => {
    const { sim, player } = makeSim();
    const seen = new Set<number>();
    for (const facing of ['north', 'east', 'south', 'west'] as const) {
      player.facing = facing;
      const yaw = sim.viewOf(player).yaw;
      assert.equal(yaw, yawOf(facing));
      seen.add(yaw as number);
    }
    assert.equal(seen.size, 4, 'four facings must be four yaws or a turn is invisible');
  });

  it('gives an unarmed mob its template’s outfit and no `wearing`', () => {
    // A mob the zone table gave nothing to is still dressed, and that is the load-bearing half now
    // that mobs *can* be armed: `mobGear` draws the template's cut, so the 1,372 of 2,016 bodies with
    // no chest piece keep their clothes. Routing mobs through `playerGear` instead would strip every
    // one of them — see `appearanceOf`'s note on why the cut beats the kit until harvested armour has
    // art of its own.
    const { sim } = makeSim();
    const view = sim.viewOf(sim.spawnMob(sentry(), 90001 as RoomId, makeRng(7))!);
    assert.equal(view.wearing, undefined, 'nothing worn, so no worn map');
    assert.deepEqual((view.gear ?? []).map((g) => g.slot), ['torso', 'arms', 'legs', 'feet']);
    assert.equal(view.sprite, 'muscular/human', 'and the 2D key is untouched');
    assert.equal(view.hands, undefined, 'empty hands, because the hands really are empty');
  });

  it('puts an armed mob’s sword on the wire, in both vocabularies', () => {
    // **Phase 16's whole payoff, and the gate that used to stop it.** `viewOf` read `wearing` and
    // `hands` off `actor.equipped` only `isPlayer(actor)` — written when a mob's kit was always empty,
    // and untrue since 15c gave `reset.ts` the zone tables' `E` commands. The gear was on the body,
    // folded into its armour class and handed to its corpse, and described to nobody.
    const { sim } = makeSim();
    const mob = sim.spawnMob(sentry(), 90001 as RoomId, makeRng(7))!;
    // `weaponClass` 5 is WEAPON_LONGSWORD, one of the four the props kit has a mesh for.
    mob.equipped.mainHand = { id: 'obj:34500', name: 'a long sword', ac: 0, size: 2, weaponClass: 5 };
    mob.equipped.chest = { id: 'obj:34501', name: 'a chain mail hauberk', ac: 3, size: 4 };
    const view = sim.viewOf(mob);
    assert.deepEqual(view.wearing, { chest: 'obj:34501', mainHand: 'obj:34500' }, 'the MUD vocabulary');
    assert.deepEqual(view.hands, { main: 'prop:Sword_Bronze' }, 'and the renderer’s');
    assert.equal(view.model, `${BASE_PREFIX}Superhero_Male_FullBody`);
  });

  it('draws nothing in a hand the props kit has no mesh for, rather than the wrong thing', () => {
    // `WEAPON_ART`'s rule applied to mobs: `weaponClass` 6 is WEAPON_MACE, one of the 687 blunt
    // instruments the four-prop kit cannot draw. **Empty beats wrong** — an empty hand reads as a
    // fist, which the combat log will happily call a punch; a mace drawn as a sword reads as a bug.
    // `wearing` still carries it, so `look` and the corpse both still know it is there.
    const { sim } = makeSim();
    const mob = sim.spawnMob(sentry(), 90001 as RoomId, makeRng(7))!;
    mob.equipped.mainHand = { id: 'obj:34502', name: 'an iron mace', ac: 0, size: 2, weaponClass: 6 };
    const view = sim.viewOf(mob);
    assert.equal(view.hands, undefined, 'no mesh, so no prop');
    assert.deepEqual(view.wearing, { mainHand: 'obj:34502' }, 'but the mace is not a secret');
  });
});

/* -------------------------------------------------------------------------- */
/* The resync                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * **What this can and cannot reach, said plainly.**
 *
 * The send itself lives in `index.ts`, which binds a socket at import (`http.listen` at the bottom of
 * the file), so no unit test in this package can call `afterKitChange` — and none does today, for
 * `wearing` either: that path was verified by the owner looking at the screen on 2026-08-07 and has
 * been live since. What *is* reachable is the payload it sends, because `syncEntityState` evaluates
 * exactly one expression — `sim.viewOf(actor)` — and that is what these tests call.
 *
 * So the claim here is the load-bearing half: **the view is rebuilt from the kit every time it is
 * asked**, with no cache and no staleness, so any caller that re-sends it after a change re-sends the
 * change. The seam being wired is a fact about `index.ts` verified by reading it:
 * `wear`/`wield`/`remove` → `afterKitChange` → `syncEntityState` → `entityUpdate` to the wearer *and*
 * every watcher.
 */
describe('a kit change reaches the body', () => {
  it('grows a torso mesh when a mail shirt goes on, and loses it when it comes off', () => {
    const { sim, player } = makeSim();
    const torso = () => sim.viewOf(player).gear?.find((g) => g.slot === 'torso')?.part;

    player.equipped = {};
    assert.equal(torso(), undefined, 'stripped');

    player.equipped = { chest: { ...item('mail_shirt', 'a shirt of mail'), slot: 'chest' } };
    assert.equal(torso(), 'outfit:Male_Ranger_Body', 'worn');

    player.equipped = {};
    assert.equal(torso(), undefined, 'removed again');
  });

  it('moves `gear` and `wearing` together, because they are one read of one kit', () => {
    // They are two vocabularies for the same fact and are built from one `actor.equipped` read in
    // `viewOf`. If they ever came from two reads, a resync could ship a body wearing one thing and
    // drawn wearing another — which is precisely the 2D/3D disagreement this slice must not create.
    const { sim, player } = makeSim();
    player.equipped = { feet: { ...item('travel_boots', 'scuffed travelling boots'), slot: 'feet' } };
    const before = sim.viewOf(player);
    assert.equal(before.wearing?.['feet'], 'travel_boots');
    assert.equal(before.gear?.find((g) => g.slot === 'feet')?.part, 'outfit:Male_Ranger_Feet_Boots');

    player.equipped = { feet: { ...item('worn_shoes', 'worn-out shoes'), slot: 'feet' } };
    const after = sim.viewOf(player);
    assert.equal(after.wearing?.['feet'], 'worn_shoes');
    assert.equal(after.gear?.find((g) => g.slot === 'feet')?.part, 'outfit:Male_Peasant_Feet');
  });

  it('reads the injected art resolver, so harvested gear reaches the mesh too', () => {
    // `artClassOf` is how a catalogue item becomes an art class — `sim.ts` holds no catalogue. The
    // 3D mapping must ride the *resolved* class, not the raw `obj:` id, or 16,421 catalogue items
    // would all fall to the same fallback.
    const { sim, player } = makeSim();
    sim.artClassOf = (held) => (held.id === 'obj:99' ? 'torso-chainmail' : undefined);
    player.equipped = { chest: { ...item('obj:99', 'a coat of chain'), slot: 'chest' } };
    assert.equal(sim.viewOf(player).wearing?.['chest'], 'torso-chainmail');
    assert.equal(sim.viewOf(player).gear?.find((g) => g.slot === 'torso')?.part, 'outfit:Male_Ranger_Body');
  });

  it('rebuilds the view rather than caching it', () => {
    const { sim, player } = makeSim();
    const first = sim.viewOf(player);
    player.equipped = { head: { ...item('cloth_hood', 'a patched hood'), slot: 'head' } };
    const second = sim.viewOf(player);
    assert.notDeepEqual(first.gear, second.gear);
    assert.equal(second.gear?.find((g) => g.slot === 'head')?.part, 'outfit:Male_Ranger_Head_Hood');
  });

  it('carries a changed hairstyle out on the very same rebuild', () => {
    // The resync, and the reason the command calls `afterKitChange` rather than inventing a path: the
    // payload is a function of the player, so *any* caller that re-sends the view after a change sends
    // the change. The send itself is `index.ts`'s and is unreachable from this package — see the
    // describe block's note; what is reachable is that the view follows the field, both ways.
    const { sim, player } = makeSim();
    player.equipped = {};
    const before = sim.viewOf(player).hair;
    assert.ok(before, 'a character with no stored choice still has hair');
    player.hair = 'long';
    assert.equal(sim.viewOf(player).hair, 'hair:Hair_Long');
    player.hair = 'bald';
    assert.equal(sim.viewOf(player).hair, undefined, 'bald is a decision the wire respects');
    player.hair = undefined;
    assert.equal(sim.viewOf(player).hair, before, 'and clearing it returns the deterministic default');
  });
});

/* -------------------------------------------------------------------------- */
/* Hair and scale, on the wire                                                  */
/* -------------------------------------------------------------------------- */

describe('what the server chooses about a body', () => {
  it('seeds a player’s default from their name, so a reconnect is not a reroll', () => {
    // The identity half of `defaultHairFor`'s contract. Two bodies with **different entity ids and the
    // same name** — which is exactly what a reconnect produces — because the failure this guards is a
    // seed taken from anything that moves, and a mob's seed *is* the entity id one test down.
    const { sim, player } = makeSim();
    const again = sim.spawn('Mannequin', makeRng(9));
    assert.notEqual(player.id, again.id, 'two different bodies');
    assert.equal(sim3dHair(sim, player), sim3dHair(sim, again));
    assert.equal(player.hair, undefined, 'and neither of them chose it');

    // …and it is a *name* rather than a constant: enough different characters reach more than one
    // style, or every player in the world would be shorn alike.
    const styles = new Set(
      ['Azder', 'Bryn', 'Corwin', 'Dain', 'Elowen', 'Fenn', 'Gwyn', 'Haldir'].map((name) =>
        sim3dHair(sim, sim.spawn(name, makeRng(3))),
      ),
    );
    assert.ok(styles.size >= 3, `eight names produced ${styles.size} hairstyles`);
  });

  it('seeds a mob’s from its entity id, so a den is not a cloning vat', () => {
    // The owner's *"two guards in a room do not match"*. Five sentries of one template, spawned into
    // one room the way `reset.ts` does — a name-seeded default would give all five the same head.
    const { sim } = makeSim();
    const styles = new Set<string | undefined>();
    for (let i = 0; i < 8; i++) {
      const mob = sim.spawnMob(sentry(), 90001 as RoomId, makeRng(7 + i))!;
      styles.add(sim.viewOf(mob).hair);
    }
    assert.ok(styles.size >= 2, `eight sentries produced ${styles.size} hairstyles`);
    for (const style of styles) assert.ok(style?.startsWith('hair:'), `${style} is not a hair id`);
  });

  it('scales the world’s youths and leaves its guards alone', () => {
    const { sim } = makeSim();
    const scaleOf = (sprite: string): number | undefined =>
      sim.viewOf(sim.spawnMob({ ...sentry(), sprite }, 90001 as RoomId, makeRng(7))!).scale;
    assert.equal(scaleOf('child/human'), 0.72);
    assert.equal(scaleOf('teen/human'), 0.88);
    // The trap, on the wire this time: `muscular` is `giant, ogre, troll … warrior, guard, champion`,
    // so scaling it would inflate every town guard in the world into an ogre.
    assert.equal(scaleOf('muscular/human'), undefined);
    assert.equal(scaleOf('male/human'), undefined);
  });
});

/** A player's drawn hairstyle, through the wire's own function. */
function sim3dHair(sim: Simulation, player: Parameters<Simulation['viewOf']>[0]): string | undefined {
  player.equipped = {};
  return sim.viewOf(player).hair;
}

/* -------------------------------------------------------------------------- */
/* The sweep, in the shipped world                                              */
/* -------------------------------------------------------------------------- */

/**
 * Skipped when `data/world` has not been generated — it is git-ignored and reproducible via
 * `npm run worldgen`, the gate `nearby.test.ts` and `world.test.ts` both use.
 */
const HAVE_SPAWNS = existsSync(SPAWNS_DIR) && readdirSync(SPAWNS_DIR).some((f) => f.endsWith('.json'));

interface Template {
  readonly vnum: number;
  readonly name: string;
  readonly sprite: string;
  /** Duris' mob race code, as harvested. Absent for a template the harvest left unraced. */
  readonly race?: string;
}

/** Every mob template the server would load, with its `mobs.json` override applied — as it ships. */
function shippedTemplates(): readonly Template[] {
  const overrides = existsSync(MOBS_FILE) ? loadMobOverrides() : new Map();
  const out: Template[] = [];
  for (const file of readdirSync(SPAWNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(SPAWNS_DIR, file), 'utf8')) as {
      templates?: readonly Record<string, unknown>[];
    };
    for (const raw of parsed.templates ?? []) {
      const base = raw as unknown as Template & Record<string, unknown>;
      const override = overrides.get(base.vnum);
      // The same merge the server performs at boot, so this sweep sees the sprites the world uses
      // rather than the ones the harvest wrote.
      const merged = override ? (applyMobOverride(base as never, override) as unknown as Template) : base;
      out.push({
        vnum: base.vnum,
        name: base.name,
        sprite: merged.sprite,
        // Off the *harvest* rather than the merge: `mobs.json` overrides sprites, never races.
        ...(typeof base.race === 'string' ? { race: base.race } : {}),
      });
    }
  }
  return out;
}

describe('every body in the shipped world', { skip: HAVE_SPAWNS ? false : 'data/world/spawns not generated' }, () => {
  it('draws an id the packs actually have, or the documented placeholder', () => {
    // **The M7a completion condition.** One bad stem is not a crash — it is a mesh that silently
    // fails to load in M7b, weeks from now, on one mob in one zone.
    const offenders: string[] = [];
    for (const t of shippedTemplates()) {
      for (const id of [
        appearanceOf({ kind: 'mob', sprite: t.sprite })?.model,
        ...(appearanceOf({ kind: 'mob', sprite: t.sprite })?.gear ?? []).map((g) => g.part),
      ]) {
        if (id !== undefined && !MANIFEST.has(id)) offenders.push(`${t.vnum} ${t.name} -> ${id}`);
      }
    }
    assert.deepEqual(offenders, [], 'these templates ask for meshes nothing staged');
  });

  it('gives every one of them a body, with no gaps', () => {
    const templates = shippedTemplates();
    assert.ok(templates.length > 1000, `expected the full harvest, got ${templates.length}`);
    for (const t of templates) {
      const look = appearanceOf({ kind: 'mob', sprite: t.sprite });
      assert.ok(look, `${t.vnum} ${t.name} has no appearance at all`);
      assert.ok(look.model.length > 0);
    }
  });

  it('sends the overwhelming majority to a real mesh rather than to the placeholder', () => {
    // The number M7b's monster-gap decision rests on. Measured 2026-08-13: 1,503 templates, 6 on the
    // `creature:` fallback — 0.4%. The bound is deliberately loose (95%) so a re-run of `mobsweep`
    // that legitimately finds more animals does not fail the build; it is a smoke alarm, not a lock.
    // If it ever fires, the monster gap has stopped being negligible and M7b needs real models.
    const templates = shippedTemplates();
    const placeholder = templates.filter((t) =>
      appearanceOf({ kind: 'mob', sprite: t.sprite })?.model.startsWith(CREATURE_PREFIX),
    );
    const share = placeholder.length / templates.length;
    assert.ok(share < 0.05, `${placeholder.length} of ${templates.length} templates have no mesh (${(share * 100).toFixed(1)}%)`);
  });

  it('dresses every body the outfit pack fits, so nobody in the world is naked', () => {
    // `wearsOutfits` rather than "not a `creature:` id", and the difference is the kobold: it has a
    // real mesh and a real `base:` id, and it is still not something the Quaternius garments go on.
    // See `appearance.wearsOutfits` — the exclusion this test used to spell for itself.
    for (const t of shippedTemplates()) {
      const look = appearanceOf({ kind: 'mob', sprite: t.sprite });
      if (!look || !wearsOutfits(look.model)) continue;
      assert.equal((look.gear ?? []).length, 4, `${t.vnum} ${t.name} is underdressed`);
    }
  });

  it('leaves a creature bare — no gear, no hands, no hair', () => {
    // The other side of the exclusion above, so "skipped" cannot quietly become "unchecked". A
    // kobold handed a peasant's tunic would be 20 garments bound to an armature that has none of
    // their joints, which draws as a cloud of triangles around the origin.
    for (const sprite of ['male/kobold', 'muscular/kobold', 'child/kobold']) {
      const look = appearanceOf({ kind: 'mob', sprite, hairSeed: 'mob:1400' });
      assert.equal(look?.model, `${BASE_PREFIX}Kobold`, sprite);
      assert.equal(look?.gear, undefined, `${sprite} is wearing something`);
      assert.equal(look?.hands, undefined, `${sprite} is holding something`);
      assert.equal(look?.hair, undefined, `${sprite} grew hair`);
    }
    // The body word still scales it, exactly as it does a person: a kobold youth is a smaller kobold.
    assert.ok((appearanceOf({ kind: 'mob', sprite: 'child/kobold' })?.scale ?? 1) < 1);
    assert.equal(appearanceOf({ kind: 'mob', sprite: 'male/kobold' })?.scale, undefined);
  });

  it('gives every humanoid in it a head of hair, and an id the pack has', () => {
    // The other half of *"nobody is bald"*, over the real population rather than a fixture: a template
    // whose seed happened to miss would be one mob in one zone with a shaved head and no error.
    const bald: string[] = [];
    for (const t of shippedTemplates()) {
      const look = appearanceOf({ kind: 'mob', sprite: t.sprite, hairSeed: `mob:${t.vnum}` });
      if (!look || !wearsOutfits(look.model)) continue;
      if (!look.hair) bald.push(`${t.vnum} ${t.name}`);
      else assert.ok(HAIR_MANIFEST.has(look.hair), `${t.vnum} ${t.name} -> ${look.hair}`);
    }
    assert.deepEqual(bald.slice(0, 5), [], `${bald.length} templates came out bald`);
  });

  it('scales exactly the bodies the sweep called young, and counts them', () => {
    // **The whole-world sweep the slice owes.** Measured 2026-08-13 over the shipped harvest with
    // `mobs.json` applied: **1,503 templates, 90 `child` and 45 `teen`** — 9% of the world drawn
    // smaller. (`mobs.json` itself holds 86 and 44; the extra five are templates whose *harvested*
    // sprite already carried a youth word and that the sweep therefore never needed to override, which
    // is exactly why this counts the merged population rather than the override file.) Asserted rather
    // than described, so a re-run of `mobsweep` that moves them is visible rather than silent.
    const byScale = new Map<number, string[]>();
    for (const t of shippedTemplates()) {
      const scale = appearanceOf({ kind: 'mob', sprite: t.sprite })?.scale ?? 1;
      (byScale.get(scale) ?? byScale.set(scale, []).get(scale)!).push(`${t.vnum} ${t.name}`);
    }
    const counts = [...byScale].sort(([a], [b]) => a - b).map(([scale, rows]) => [scale, rows.length]);
    // Three buckets and no fourth: the table has two rows and everything else draws at 1.
    assert.deepEqual(counts, [[0.72, 90], [0.88, 45], [1, 1368]]);

    // And the one the brief warns about, checked against the population rather than the table: every
    // `muscular` body — 283 of them, including every town guard in the world — draws at adult height.
    const muscular = shippedTemplates().filter((t) => t.sprite.startsWith('muscular/'));
    assert.ok(muscular.length > 100, `expected the martial row to be populous, got ${muscular.length}`);
    for (const t of muscular) {
      assert.equal(appearanceOf({ kind: 'mob', sprite: t.sprite })?.scale, undefined, `${t.vnum} ${t.name}`);
    }
  });

  it('makes the giants giant, and counts every size the world actually ships', () => {
    // **The second whole-world sweep, and it exists because the first one is blind to this axis.**
    // The test above passes no `race`, so every assertion in it is about the body word alone — which
    // was the whole truth until `RACE_SIZE` landed and is now a *subset* of it. A slice that added a
    // second scale input and left only the first one swept would read as fully covered.
    //
    // Measured 2026-08-13 over the shipped harvest. Every count here is a join of two tables neither
    // of which this project wrote: the harvest's `race` column, and `common.c`'s `race_size()`.
    const byScale = new Map<number, string[]>();
    for (const t of shippedTemplates()) {
      const look = appearanceOf({ kind: 'mob', sprite: t.sprite, ...(t.race ? { race: t.race } : {}) });
      const scale = look?.scale ?? 1;
      (byScale.get(scale) ?? byScale.set(scale, []).get(scale)!).push(`${t.vnum} ${t.name}`);
    }
    const counts = [...byScale].sort(([a], [b]) => a - b).map(([scale, rows]) => [scale, rows.length]);

    // The population is 1,503 and every one of them lands in a bucket the two tables predict.
    assert.equal(
      counts.reduce((n, [, rows]) => n + (rows as number), 0),
      shippedTemplates().length,
    );
    // 168 `G` at 2.75 is the headline: the treants, the giants and everything the builders filed as
    // one have stood at a grown man's height since M7b.
    assert.ok((byScale.get(2.75) ?? []).length >= 150, `expected the giants, got ${(byScale.get(2.75) ?? []).length}`);
    assert.ok((byScale.get(2) ?? []).length >= 10, `expected the ogres, got ${(byScale.get(2) ?? []).length}`);

    // **The trolls are checked by height and not by scale, and that is the lesson of the slice.**
    // This line used to assert `scale === 1.5` and it was right until the troll got a mesh of its own
    // — authored at 2.709 m, so its scale is now **1** and the old assertion read zero trolls. The
    // scale was never the thing worth pinning; it is an implementation detail of *which mesh* is
    // being stretched. How tall a troll is drawn is the fact, and it survives the next creature model
    // as well as it survived this one.
    const tall = shippedTemplates().filter((t) => {
      const look = appearanceOf({ kind: 'mob', sprite: t.sprite, ...(t.race ? { race: t.race } : {}) });
      return look ? drawnHeightOf(look.model, look.scale) > 2.5 : false;
    });
    assert.ok(tall.length >= 200, `expected the world's big bodies, got ${tall.length}`);
    for (const t of shippedTemplates().filter((c) => c.race === 'PT')) {
      const look = appearanceOf({ kind: 'mob', sprite: t.sprite, race: 'PT' });
      assert.equal(look?.model, `${BASE_PREFIX}Troll`, `${t.vnum} ${t.name} is not drawn as a troll`);
      // Its own mesh, so no race multiple on top of it — the double-count this ordering prevents.
      assert.equal(look?.scale ?? 1, bodyScaleFor(t.sprite.split('/')[0] ?? ''), `${t.vnum} scaled twice`);
    }

    // **Age times race, over the real population** — the product, not either factor. A `child` of a
    // large race must land on neither 0.72 nor 1.5.
    const young = shippedTemplates().filter(
      (t) => /^(child|teen)\//.test(t.sprite) && t.race !== undefined && raceScaleFor(t.race) !== 1,
    );
    for (const t of young) {
      const look = appearanceOf({ kind: 'mob', sprite: t.sprite, race: t.race! });
      const expected = bodyScaleFor(t.sprite.split('/')[0]!) * raceScaleFor(t.race!);
      assert.equal(look?.scale, expected, `${t.vnum} ${t.name}`);
    }

    // **And the kobolds are not scaled twice.** Their mesh is authored at 0.756 m and `RACE_KOBOLD` is
    // `SIZE_SMALL`; a kobold that picked up the 0.6 as well would be drawn at 0.45 m. This is the one
    // assertion in the file that would fail if the creature branch were ever moved below the race one.
    for (const t of shippedTemplates().filter((c) => c.sprite.endsWith('/kobold'))) {
      const look = appearanceOf({ kind: 'mob', sprite: t.sprite, ...(t.race ? { race: t.race } : {}) });
      assert.equal(look?.scale ?? 1, bodyScaleFor(t.sprite.split('/')[0]!), `${t.vnum} ${t.name} was scaled twice`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The manifest against the pack itself                                         */
/* -------------------------------------------------------------------------- */

/**
 * Reads the file names out of a zip's **central directory**, without unpacking it.
 *
 * Thirty lines rather than a dependency, and rather than trusting a measurement taken once in a
 * report: the whole premise of `appearance.ts` is that its stems are **real file identities**, and the
 * only thing that can keep that true as the packs are re-downloaded or re-tiered is a check that reads
 * the pack.
 *
 * **Only the tail is read, and that is the difference between a test and a stall.** These zips are 294
 * MB and 129 MB; slurping both and scanning every byte for the `PK\x01\x02` signature took 13 seconds
 * of a suite that runs on every commit. The format puts an *end of central directory* record in the
 * last 64 KB, which names where the directory starts and how long it is, so two positional reads get
 * the same answer in milliseconds. No inflater is involved either way — names are stored in the clear.
 */
function zipEntryNames(path: string): readonly string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    // The EOCD is 22 bytes plus a comment of at most 64 KB, so the last 64 KB + 22 always contains it.
    const tailLength = Math.min(size, 0x10000 + 22);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, size - tailLength);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error(`${path}: no end-of-central-directory record`);

    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryAt = tail.readUInt32LE(eocd + 16);
    const directory = Buffer.alloc(directorySize);
    readSync(fd, directory, 0, directorySize, directoryAt);

    const names: string[] = [];
    // Each entry: 46-byte fixed header, then name, extra and comment, whose lengths are at +28/+30/+32.
    for (let at = 0; at + 46 <= directory.length; ) {
      if (directory.readUInt32LE(at) !== 0x02014b50) break;
      const nameLength = directory.readUInt16LE(at + 28);
      names.push(directory.toString('utf8', at + 46, at + 46 + nameLength));
      at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    }
    return names;
  } finally {
    closeSync(fd);
  }
}

const KIT_DIR = 'D:/MyGame/assets/quaternius';
const OUTFIT_ZIP = join(KIT_DIR, 'modular-character-outfits-fantasy-standard.zip');
const BASE_ZIP = join(KIT_DIR, 'universal-base-characters-standard.zip');
const HAVE_PACKS = existsSync(OUTFIT_ZIP) && existsSync(BASE_ZIP);

describe('the manifest against the packs on disk', { skip: HAVE_PACKS ? false : 'assets/quaternius packs not present' }, () => {
  /** Every glTF stem in a pack — the vendor's own file identities. Read once per zip, not per test. */
  const cache = new Map<string, ReadonlySet<string>>();
  const stems = (zip: string): ReadonlySet<string> => {
    const cached = cache.get(zip);
    if (cached) return cached;
    const found = new Set(
      zipEntryNames(zip)
        .filter((n) => n.endsWith('.gltf'))
        .map((n) => n.slice(n.lastIndexOf('/') + 1, -'.gltf'.length)),
    );
    cache.set(zip, found);
    return found;
  };

  it('names only meshes the outfit pack ships', () => {
    const have = stems(OUTFIT_ZIP);
    assert.ok(have.size > 0, 'the zip should hold glTF files');
    for (const id of everyGearPartId()) {
      assert.ok(have.has(id.slice('outfit:'.length)), `${id} is not in the pack`);
    }
  });

  it('names only meshes the base-character pack ships', () => {
    const have = stems(BASE_ZIP);
    for (const id of everyModelId()) {
      // A creature is authored in-house and is not in anybody's zip — that it was *staged* is
      // `client3d/characters.test.ts`'s join against the built manifest, which is the only place it
      // can be checked, because this one only knows what Quaternius sold us.
      if (!id.startsWith(BASE_PREFIX) || !wearsOutfits(id)) continue;
      assert.ok(have.has(id.slice(BASE_PREFIX.length)), `${id} is not in the pack`);
    }
  });

  it('still finds exactly the 20 modular parts the manifest was measured against', () => {
    // The count that `HANDOFF.md`'s "Peasant/Ranger/etc" got wrong. If a re-download changes it, this
    // fails here rather than as a missing mesh in the renderer. The four excluded stems are the
    // whole-outfit assemblies under `Outfits/`, which are the same geometry pre-joined.
    const parts = [...stems(OUTFIT_ZIP)].filter((s) => !/^(Female|Male)_(Peasant|Ranger)$/.test(s));
    assert.equal(parts.length, 20, `the Modular Parts line is 20 files, found ${parts.length}`);
    assert.deepEqual(parts.sort(), everyGearPartId().map((id) => id.slice('outfit:'.length)).sort());
  });

  it('has no meshes for the animals, which is why the placeholder exists', () => {
    // `Ultimate Monsters` is not on itch. Asserting the absence keeps the `creature:` scheme honest:
    // the day a monster pack lands, this test fails and somebody has to decide what to do about it.
    const everything = new Set([...stems(OUTFIT_ZIP), ...stems(BASE_ZIP)]);
    for (const id of everyModelId()) {
      if (!id.startsWith(CREATURE_PREFIX)) continue;
      const shape = id.slice(CREATURE_PREFIX.length);
      assert.ok(
        ![...everything].some((s) => s.toLowerCase().includes(shape)),
        `${shape} now has a mesh — retire its creature: fallback`,
      );
    }
  });
});
