/**
 * Harvesting population: the `.mob` and `.zon` parsers, and the room pairing.
 *
 * This is the module with the most silent-failure risk in the project. A field read one position along
 * gives a guard with 51 hit points instead of level 51 and *looks entirely plausible*; a room mapping that
 * picks arbitrarily among four rooms of the same name clusters four mobs into one corner and looks like a
 * builder's choice. Neither shows up as an error, which is why they are pinned here against fixtures whose
 * every number is different from every other.
 *
 * Fixtures rather than the real files: the real ones are git-ignored third-party data, so a test that read
 * them would pass on this machine and fail on a fresh checkout.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { boundsOf, type Room, type Zone } from '@mygame/shared';

import type { DurisRoom } from './duris.ts';
import {
  buildRoomMap,
  buildZoneSpawns,
  newSpawnStats,
  parseMobFile,
  parseZoneFile,
  spriteFor,
} from './mobs.ts';

const dir = mkdtempSync(join(tmpdir(), 'mygame-mobs-'));
const write = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, body, 'latin1');
  return path;
};

/**
 * One `.mob` record, in the exact shape Duris writes.
 *
 * Every number is deliberately distinct so a field read one position along cannot coincidentally pass:
 * level 51, hitroll 15, armour 22, and hit points `9d7+13`.
 */
const SENTRY = `#97018
sentry guard watch~
&+ya sentry&N~
&+yA sentry stands watch beneath the arch.&N
~
He wears the tabard of the castle guard and looks thoroughly bored.
~
141 0 0 0 0 0 0 0 -350 S
H 0 0 -1
51 15 22 9d7+13 2d5+2
7.6.2.0 7290
8 8 2
`;

describe('parsing a .mob record', () => {
  it('reads the fields it needs and no others', () => {
    const { templates, skipped } = parseMobFile(write('one.mob', SENTRY));
    assert.deepEqual(skipped, []);
    assert.equal(templates.length, 1);
    const t = templates[0]!;
    assert.equal(t.vnum, 97018);
    // Keywords are authored upstream, so no derivation from the display name is needed — which is the
    // stopgap `commands.ts` documents for items and does not need here.
    assert.deepEqual(t.keywords, ['sentry', 'guard', 'watch']);
    // Colour codes stripped: `&+y` is Duris' own markup and would otherwise be read aloud.
    assert.equal(t.name, 'a sentry');
    assert.equal(t.room, 'A sentry stands watch beneath the arch.');
    assert.equal(t.level, 51, 'level, not the hitroll beside it');
    assert.equal(t.hp, '9d7+13');
    assert.equal(t.sprite, 'human');
  });

  it('reads several records from one file', () => {
    const second = SENTRY.replace('#97018', '#97019').replace('a sentry', 'a captain');
    const { templates } = parseMobFile(write('two.mob', SENTRY + second));
    assert.deepEqual(templates.map((t) => t.vnum), [97018, 97019]);
    assert.deepEqual(templates.map((t) => t.name), ['a sentry', 'a captain']);
  });

  it('refuses a record whose type letter is not the simple form', () => {
    // An `E`-type carries extra keyed lines. Half-parsing it would produce plausible nonsense, so it is a
    // named skip instead — and the report prints the count.
    const enhanced = SENTRY.replace('-350 S', '-350 E');
    const { templates, skipped } = parseMobFile(write('enhanced.mob', enhanced));
    assert.deepEqual(templates, []);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!.why, /not the simple form/);
  });

  it('refuses a record whose level or hit points do not read as numbers', () => {
    const broken = SENTRY.replace('51 15 22 9d7+13 2d5+2', 'lots 15 22 wounds 2d5+2');
    const { templates, skipped } = parseMobFile(write('broken.mob', broken));
    assert.deepEqual(templates, []);
    assert.match(skipped[0]!.why, /unreadable level\/hp/);
  });

  it('drops a creature we have no body for, rather than drawing it as a person', () => {
    // The owner's rule: a chicken shaped like a man is the sort of placeholder that stops being noticed
    // and ships. `A` is Duris' code for Animal, and the LPC base bodies are humanoids only.
    const animal = SENTRY.replace('\nH 0 0 -1', '\nA 0 0 -1').replace('a sentry', 'the snowfox');
    const { templates, skipped } = parseMobFile(write('animal.mob', animal));
    assert.deepEqual(templates, []);
    assert.match(skipped[0]!.why, /race "A" has no body/);
  });

  it('maps only the races it can draw', () => {
    assert.equal(spriteFor('H'), 'human');
    assert.equal(spriteFor('PB'), 'human');
    // A giant is a humanoid whose scale is wrong, which is a different order of error from a category one.
    assert.equal(spriteFor('G'), 'human');
    assert.equal(spriteFor('A'), undefined, 'Animal');
    assert.equal(spriteFor('EW'), undefined, 'Water Elemental');
    assert.equal(spriteFor('Y'), undefined, 'Devil');
  });
});

/* -------------------------------------------------------------------------- */

const ZON = `#970
&+WTest &+CKeep&n~
test~
97289 2 0 55 65 1
*
* a builder's comment, of which the real files are mostly made
*
D 0 97026 0 2 100 0 0 0
*     north exit, closed and locked
M 0 97052 3 97002 100 0 0 0        * the snowfox
E 1 91000 5 16 100 0 0 0           * its collar
M 0 97053 2 97004 100 0 0 0        * the coyote
S
`;

describe('parsing a .zon file', () => {
  it('reads the lifespan band from the header', () => {
    // The band, not a single number: a fresh lifespan is re-rolled from it after every reset, which is what
    // stops repop happening on a timetable.
    const parsed = parseZoneFile(write('a.zon', ZON));
    assert.ok(parsed);
    assert.equal(parsed.vnum, 970);
    assert.equal(parsed.lifespanMin, 55);
    assert.equal(parsed.lifespanMax, 65);
  });

  it('reads the commands, skipping comments', () => {
    const parsed = parseZoneFile(write('b.zon', ZON));
    assert.ok(parsed);
    assert.deepEqual(parsed.commands.map((c) => c.kind), ['door', 'mob', 'equip', 'mob']);
  });

  it('reads an M command’s vnum, limit, room and percentage', () => {
    const parsed = parseZoneFile(write('c.zon', ZON));
    const first = parsed!.commands.find((c) => c.kind === 'mob');
    assert.ok(first);
    assert.equal(first.what, 97052);
    assert.equal(first.limit, 3);
    assert.equal(first.durisRoom, 97002, 'still a Duris vnum at this stage');
    assert.equal(first.percent, 100);
  });

  it('reads a D command’s room from arg1, where a mob’s comes from arg3', () => {
    // The one positional difference between the two, and getting it wrong resets a door in the wrong room —
    // which looks like a builder's mistake rather than a parser's.
    const parsed = parseZoneFile(write('d.zon', ZON));
    const door = parsed!.commands.find((c) => c.kind === 'door');
    assert.ok(door);
    assert.equal(door.durisRoom, 97026);
    assert.equal(door.direction, 'north', 'Diku D0 is north');
    assert.equal(door.doorState, 'locked', 'state 2 of the low two bits');
  });

  it('reads arg3 as a wear position on E, not as a room', () => {
    // **The bug 15c fixed, pinned.** `renum_zone` translates only `arg1` for an `E`; `arg3` is the wear
    // position — 16 is `PRIMARY_WEAPON`, the commonest value in the world. Reading it as a room meant
    // looking up "room 16", missing, and dropping the command: all 16,263 of them, silently.
    const parsed = parseZoneFile(write('h.zon', ZON));
    const equip = parsed!.commands.find((c) => c.kind === 'equip');
    assert.ok(equip);
    assert.equal(equip.wearPosition, 16);
    assert.equal(equip.durisRoom, undefined, 'an E command has no room at all');
  });

  it('reads arg3 as the container on P, and gives G no arg3 at all', () => {
    // `P` puts an object inside another *object*; `G` gives one to the last mobile loaded and takes no
    // third argument. Both were read as rooms. `P`'s survivors were coincidences — a container vnum that
    // happened to collide with a room vnum — carrying a room that pointed somewhere unrelated.
    const zon = ZON.replace('S\n', 'G 1 91001 2 0 100\nP 1 91002 1 91003 100\nS\n');
    const parsed = parseZoneFile(write('i.zon', zon));
    const give = parsed!.commands.find((c) => c.kind === 'give');
    const put = parsed!.commands.find((c) => c.kind === 'put');
    assert.equal(give?.durisRoom, undefined);
    assert.equal(give?.what, 91001);
    assert.equal(put?.container, 91003, 'the container is an object vnum');
    assert.equal(put?.durisRoom, undefined);
  });

  it('reads the door state out of the low two bits only', () => {
    // `|4` is secret and `|8` blocked, and neither has a mechanic here — `Door` carries closed and locked
    // and nothing else. Masking rather than comparing means a secret closed door still reads as closed.
    const secret = ZON.replace('D 0 97026 0 2 100', 'D 0 97026 0 6 100');
    const parsed = parseZoneFile(write('e.zon', secret));
    assert.equal(parsed!.commands.find((c) => c.kind === 'door')?.doorState, 'locked');
  });

  it('records the if_flag, so the chain can be honoured', () => {
    const parsed = parseZoneFile(write('f.zon', ZON));
    const equip = parsed!.commands.find((c) => c.kind === 'equip');
    assert.equal(equip?.ifPrevious, true);
    assert.equal(parsed!.commands.find((c) => c.kind === 'mob')?.ifPrevious, false);
  });

  it('stops at S rather than reading past the table', () => {
    const trailing = ZON + 'M 0 99999 1 97002 100\n';
    const parsed = parseZoneFile(write('g.zon', trailing));
    assert.equal(parsed!.commands.filter((c) => c.kind === 'mob').length, 2, 'the row past S is not read');
  });
});

/* -------------------------------------------------------------------------- */

/** Our side: four rooms sharing a name, plus one unique, exactly the shape that makes pairing necessary. */
function ourZone(): Zone {
  const rooms: Room[] = [
    { id: 500, zone: 900, name: 'A Corner In the Ice Garden', sector: 'forest', pos: { x: 0, y: 0, z: 0 }, exits: {} },
    { id: 501, zone: 900, name: 'A Corner In the Ice Garden', sector: 'forest', pos: { x: 1, y: 0, z: 0 }, exits: {} },
    { id: 502, zone: 900, name: 'A Corner In the Ice Garden', sector: 'forest', pos: { x: 2, y: 0, z: 0 }, exits: {} },
    { id: 503, zone: 900, name: 'A Corner In the Ice Garden', sector: 'forest', pos: { x: 3, y: 0, z: 0 }, exits: {} },
    { id: 600, zone: 900, name: 'The Grand Foyer', sector: 'inside', pos: { x: 0, y: 1, z: 0 }, exits: {} },
  ];
  return { id: 900, name: 'Test Garden', rooms, bounds: boundsOf(rooms), entryRoom: 500 };
}

const duris = (vnum: number, name: string): DurisRoom => ({
  vnum,
  file: 'test.wld',
  name,
  key: name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  description: '',
  flags: 0,
  sector: 0,
});

describe('mapping Duris room vnums onto ours', () => {
  it('pairs duplicated names positionally, one for one', () => {
    // The measured justification: of IceCrag's 37 duplicated names, all 37 have the same count on both
    // sides. So Duris' four Ice Garden corners are our four, and zipping them sorted puts one mob in each —
    // faithful as a *distribution* even where it cannot be about which corner is which.
    const map = buildRoomMap(ourZone(), [
      duris(97_004, 'A Corner In the Ice Garden'),
      duris(97_001, 'A Corner In the Ice Garden'),
      duris(97_003, 'A Corner In the Ice Garden'),
      duris(97_002, 'A Corner In the Ice Garden'),
      duris(97_010, 'The Grand Foyer'),
    ]);
    assert.deepEqual(
      [...map.entries()].sort((a, b) => a[0] - b[0]),
      [[97_001, 500], [97_002, 501], [97_003, 502], [97_004, 503], [97_010, 600]],
    );
  });

  it('is a pure function of the two files, whatever order they arrive in', () => {
    // Worldgen output must be byte-identical run to run, so the sort on both sides is load-bearing.
    const rooms = [
      duris(97_002, 'A Corner In the Ice Garden'),
      duris(97_001, 'A Corner In the Ice Garden'),
    ];
    const forward = buildRoomMap(ourZone(), rooms);
    const backward = buildRoomMap(ourZone(), [...rooms].reverse());
    assert.deepEqual([...forward.entries()].sort(), [...backward.entries()].sort());
  });

  it('leaves the surplus unmapped when one side has more', () => {
    // Two names in Kobold Settlement are like this, both Duris having more. The extra vnums resolve to
    // nothing and their commands are dropped and counted, rather than doubling up on a room.
    const map = buildRoomMap(ourZone(), [
      duris(1, 'The Grand Foyer'),
      duris(2, 'The Grand Foyer'),
      duris(3, 'The Grand Foyer'),
    ]);
    assert.equal(map.size, 1);
    assert.equal(map.get(1), 600);
  });

  it('maps nothing for a name we do not have', () => {
    const map = buildRoomMap(ourZone(), [duris(1, 'A Room Toril Never Had')]);
    assert.equal(map.size, 0);
  });
});

describe('assembling a zone’s population', () => {
  it('translates rooms and drops what cannot be placed', () => {
    const zone = ourZone();
    const mobPath = write('asm.mob', SENTRY.replace('#97018', '#97052'));
    const zonPath = write(
      'asm.zon',
      `#970\nname~\nfile~\n1 2 0 10 20 1\n` +
        // Two commands: one into a room that maps, one into a room that does not.
        `M 0 97052 3 97002 100\nM 0 97052 3 55555 100\nS\n`,
    );
    const stats = newSpawnStats();
    const built = buildZoneSpawns(
      zone,
      'test.wld',
      mobPath,
      zonPath,
      [duris(97_002, 'A Corner In the Ice Garden')],
      stats,
    );
    assert.ok(built);
    assert.equal(built.zone, 900);
    assert.equal(built.lifespanMin, 10);
    assert.equal(built.lifespanMax, 20);
    assert.equal(built.templates.length, 1);
    assert.equal(built.resets.length, 1, 'the unmappable room is dropped, not guessed at');
    assert.equal(built.resets[0]!.room, 500, 'and the other carries OUR room id');
    assert.equal(stats.commandsDropped, 1);
  });

  it('drops a command for a template it did not keep', () => {
    // This is how the five IceCrag mobs with no LPC body stay out of the world rather than turning up as
    // men: the template is skipped, so every command naming it goes too.
    const zone = ourZone();
    const mobPath = write('nokeep.mob', SENTRY.replace('\nH 0 0 -1', '\nA 0 0 -1'));
    const zonPath = write('nokeep.zon', `#970\nname~\nfile~\n1 2 0 10 20 1\nM 0 97018 3 97002 100\nS\n`);
    const stats = newSpawnStats();
    const built = buildZoneSpawns(zone, 'test.wld', mobPath, zonPath, [duris(97_002, 'A Corner In the Ice Garden')], stats);
    assert.ok(built);
    assert.deepEqual(built.templates, []);
    assert.deepEqual(built.resets, []);
    assert.equal(stats.commandsDropped, 1);
  });

  it('keeps a mob’s kit instead of dropping it for having no room', () => {
    // **The regression this whole slice exists for.** `G` and `E` place a thing on the last mobile
    // loaded, so they carry no room — and requiring one of them deleted every mob's equipment in the
    // world without a word. The proof is that the sentry keeps its collar and its purse.
    const zone = ourZone();
    const mobPath = write('kit.mob', SENTRY);
    const zonPath = write(
      'kit.zon',
      `#970\nname~\nfile~\n1 2 0 10 20 1\nM 0 97018 3 97002 100\nE 1 91000 5 16 100\nG 1 91001 2 0 100\nS\n`,
    );
    const stats = newSpawnStats();
    const built = buildZoneSpawns(zone, 'test.wld', mobPath, zonPath, [duris(97_002, 'A Corner In the Ice Garden')], stats);
    assert.ok(built);
    assert.deepEqual(built.resets.map((r) => r.kind), ['mob', 'equip', 'give']);
    assert.equal(stats.commandsDropped, 0);

    const equip = built.resets.find((r) => r.kind === 'equip');
    assert.equal(equip?.wearPosition, 16, 'PRIMARY_WEAPON, carried through');
    assert.equal(equip?.room, undefined, 'and no room invented for it');
  });
});
