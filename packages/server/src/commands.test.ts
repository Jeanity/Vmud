import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { POSTURES, STATUSES, meets } from '@mygame/shared';

import {
  COMMANDS,
  COMMAND_REQUIREMENTS,
  COMMAND_BURST,
  COMMAND_REFILL_MS,
  directionOf,
  findTarget,
  isName,
  keywordsFromName,
  lookupCommand,
  newCommandBudget,
  parseTargetRef,
  spendCommand,
  splitCommand,
} from './commands.ts';

describe('lookupCommand — abbreviation by table order', () => {
  it('gives the single-letter abbreviations every Diku player has in their fingers', () => {
    // This is the whole reason the table is ordered rather than sorted. If any of these change, a
    // player's muscle memory starts doing something else and nothing looks broken.
    const expected: readonly (readonly [string, string])[] = [
      ['n', 'north'], ['e', 'east'], ['s', 'south'], ['w', 'west'],
      ['u', 'up'], ['d', 'down'],
      ['l', 'look'], ['k', 'kill'], ['h', 'help'],
      ['o', 'open'], ['c', 'close'],
      // 15b. Both of these are free letters — nothing above them starts with `g` or `i` — so they
      // land on the abbreviation Diku has always given them.
      ['g', 'get'], ['i', 'inventory'],
    ];
    for (const [typed, command] of expected) {
      assert.equal(lookupCommand(typed), command, `"${typed}" should be ${command}`);
    }
  });

  it('resolves the two-letter cases the single letters leave over', () => {
    assert.equal(lookupCommand('ex'), 'exits');
    assert.equal(lookupCommand('sa'), 'say');
    assert.equal(lookupCommand('wh'), 'who');
    assert.equal(lookupCommand('si'), 'sit');
    assert.equal(lookupCommand('sl'), 'sleep');
    assert.equal(lookupCommand('wa'), 'wake');
    assert.equal(lookupCommand('kn'), 'kneel');
  });

  it('gives "st" to stand rather than to stop', () => {
    // This changed when the posture commands landed, on purpose. `st` is stand in every Diku
    // descendant and it is what a returning player's fingers will do; `stop` is our own invention for
    // cancelling a click-to-move route and is perfectly reachable as `sto`. Table order is what
    // decides it, so the fix was placing `stand` above `stop` rather than special-casing anything.
    assert.equal(lookupCommand('st'), 'stand');
    assert.equal(lookupCommand('sto'), 'stop');
  });

  it('leaves movement alone when the item commands are added', () => {
    // The check that matters about 15b's five: each sits *below* a command it shares a prefix with, so
    // the short forms a player's fingers already know are untouched. Getting this wrong would rebind a
    // movement key — `d` walking you down is not something to rediscover mid-fight.
    assert.equal(lookupCommand('d'), 'down', 'not drop');
    assert.equal(lookupCommand('dr'), 'drop');
    assert.equal(lookupCommand('w'), 'west', 'not wear');
    assert.equal(lookupCommand('we'), 'west', 'still west');
    assert.equal(lookupCommand('wea'), 'wear');
    assert.equal(lookupCommand('r'), 'rest', 'not remove');
    assert.equal(lookupCommand('re'), 'rest');
    assert.equal(lookupCommand('rem'), 'remove');
    assert.equal(lookupCommand('inv'), 'inventory');
  });

  it('leaves everything alone when Phase 18\'s four are added', () => {
    // Same check as 15b's, for the four grouping verbs. The two that could have gone wrong are `g` and
    // `c`: `get` and `close` are both above, and a single letter that stopped meaning what it meant is
    // the kind of change nobody notices until they type it under pressure.
    assert.equal(lookupCommand('g'), 'get', 'not group');
    assert.equal(lookupCommand('ge'), 'get');
    assert.equal(lookupCommand('gr'), 'group');
    assert.equal(lookupCommand('gs'), 'gsay');
    assert.equal(lookupCommand('c'), 'close', 'not consent');
    assert.equal(lookupCommand('cl'), 'close');
    assert.equal(lookupCommand('co'), 'consent');
    assert.equal(lookupCommand('d'), 'down', 'still down');
    assert.equal(lookupCommand('di'), 'disband');
  });

  it('prefers an exact match over a prefix of something above it', () => {
    // The reason the lookup makes two passes rather than one. Every command must resolve to itself
    // when typed in full, whatever sits above it in the table — otherwise adding a command silently
    // steals a word that already worked.
    for (const name of COMMANDS) {
      assert.equal(lookupCommand(name), name, `"${name}" typed in full`);
    }
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    assert.equal(lookupCommand('  NORTH '), 'north');
    assert.equal(lookupCommand('Sa'), 'say');
  });

  it('matches nothing on an empty word rather than the first row', () => {
    // Duris' own helper treats a zero-length argument as "already found" and returns the first row,
    // which here would make a bare Enter walk you north.
    assert.equal(lookupCommand(''), undefined);
    assert.equal(lookupCommand('   '), undefined);
  });

  it('refuses a word that is not a prefix of anything', () => {
    assert.equal(lookupCommand('xyzzy'), undefined);
    assert.equal(lookupCommand('northward'), undefined, 'longer than the command is not a prefix');
  });

  it('knows which commands are directions', () => {
    assert.equal(directionOf('north'), 'north');
    assert.equal(directionOf('down'), 'down');
    assert.equal(directionOf('look'), undefined);
  });
});

describe('COMMAND_REQUIREMENTS', () => {
  it('declares a minimum for every command, with none left behind', () => {
    // The gate reads this table and nothing else, so a command missing from it would be gated by
    // `undefined` — which in a `meets` call is a crash, and in a sloppier implementation would be a
    // silent bypass.
    for (const command of COMMANDS) {
      const need = COMMAND_REQUIREMENTS[command];
      assert.ok(need, `${command} has no requirement`);
      assert.ok(POSTURES.includes(need.posture), `${command} posture`);
      assert.ok(STATUSES.includes(need.status), `${command} status`);
    }
  });

  it('keeps the interface commands available at the floor', () => {
    // `help`, `who` (and `score`, when it exists) are registered STAT_DEAD upstream. Reading the
    // interface is not acting — and `affects` is the same kind of thing: what is wrong with you is
    // exactly what you want to be able to read while it is killing you.
    for (const command of ['help', 'who', 'stop', 'affects'] as const) {
      assert.equal(COMMAND_REQUIREMENTS[command].status, 'dead', command);
      assert.equal(COMMAND_REQUIREMENTS[command].posture, 'prone', command);
    }
  });

  it('lets a sleeper wake, and otherwise only read the interface', () => {
    // `sleep` passes the gate and is then refused by its own handler with "you are already fast
    // asleep", which is how `do_sleep` reads too — the gate is about the body, not about whether the
    // action is redundant.
    // The four shop verbs are here for a reason that is not laziness: `interp.c` registers them with
    // `CMD_TRIG`, the macro for *"reserved keywords that don't DO anything, but are used to trigger
    // specials"*, which sets `minimum_position = STAT_DEAD + POS_PRONE` on every one. The table
    // genuinely imposes nothing — the shopkeeper's own routine is the gate, and `keeperFor` in
    // `index.ts` is where ours lives ("you will have to be awake and on your feet"). Transcribed
    // rather than tidied, because moving the check into this table would put it a layer too low.
    // Phase 18 added two to this list and both are the source's own rows. `consent` is `STAT_DEAD`,
    // which is lower than sleeping — and it is an *act*, not interface, which reads oddly until you
    // notice what consent does in `do_consent`: it also drops your saving throws against that person's
    // spells, so the moment you most need to give it is while somebody is trying to raise your corpse.
    // `disband` is `STAT_SLEEPING`, where `group` is not: dissolving a party is one word said in your
    // sleep, and reading a roster to enrol people is not.
    const asleep = { posture: 'prone', status: 'sleeping' } as const;
    const allowed = COMMANDS.filter((c) => meets(asleep, COMMAND_REQUIREMENTS[c]));
    // Phase 19 added `skills` to the list, and it belongs there for `affects`' reason: what you are good
    // at is interface, not action, and reading it while something is killing you is exactly when you want
    // to.
    // `equipment` joined 2026-08-07 with the inventory split, and it is the source's own row —
    // `CMD_Y(CMD_EQUIPMENT, STAT_SLEEPING + POS_PRONE)`, laxer than inventory's resting: checking what
    // you are wearing is interface too.
    // `spells` joined 2026-08-07 on `skills`' own row and reasoning: what magic exists is interface.
    assert.deepEqual([...allowed].sort(), [
      'affects', 'buy', 'consent', 'disband', 'equipment', 'help', 'list', 'sell', 'skills', 'sleep',
      'spells', 'stop', 'value', 'wake', 'who',
    ]);
  });

  it('lets someone flat on their back look and talk', () => {
    // What makes the dying window playable rather than a blackout.
    const floored = { posture: 'prone', status: 'resting' } as const;
    assert.ok(meets(floored, COMMAND_REQUIREMENTS.look));
    assert.ok(meets(floored, COMMAND_REQUIREMENTS.say));
    assert.ok(!meets(floored, COMMAND_REQUIREMENTS.exits), 'but not reach a door handle');
    assert.ok(!meets(floored, COMMAND_REQUIREMENTS.open));
  });

  it('requires standing to move, which is our one divergence from the source', () => {
    // Duris gives movement STAT_NORMAL + POS_PRONE — any posture — because a room there is a point
    // and moving is a teleport between points. We have continuous steering, so a seated character
    // gliding across the floor would be a rendering fault rather than a mechanic.
    for (const dir of ['north', 'east', 'south', 'west', 'up', 'down'] as const) {
      assert.equal(COMMAND_REQUIREMENTS[dir].status, 'normal', dir);
      assert.equal(COMMAND_REQUIREMENTS[dir].posture, 'standing', dir);
    }
    const seated = { posture: 'sitting', status: 'normal' } as const;
    assert.equal(meets(seated, COMMAND_REQUIREMENTS.north), false);
  });
});

/**
 * The third gate: what fighting forbids.
 *
 * `DESIGN-engagement.md` §6 transcribes these from `interp.c`'s `CMD_Y`/`CMD_N` registration rather than
 * choosing them, and the rows worth testing are the ones that show the gate is **independent** of the two
 * position axes — because if it were a posture consequence it would not need to exist.
 */
describe('what combat forbids', () => {
  const forbidden = (command: keyof typeof COMMAND_REQUIREMENTS) =>
    COMMAND_REQUIREMENTS[command].inCombat === false;

  it('refuses the exits but not the interface', () => {
    for (const dir of ['north', 'east', 'south', 'west', 'up', 'down'] as const) {
      assert.equal(forbidden(dir), true, dir);
    }
    for (const command of ['look', 'exits', 'say', 'help', 'affects', 'stop', 'kill'] as const) {
      assert.equal(forbidden(command), false, command);
    }
  });

  it('allows posture and refuses status, which is why the gate is its own axis', () => {
    // The sharpest row in the table. `sit`, `kneel` and `stand` are allowed mid-fight; `rest` and `sleep`
    // are not. You can be knocked about and get back up, but you cannot opt out of consciousness — and
    // that lands on one of Phase 4's two axes and not the other, which a single collapsed position enum
    // could not have expressed.
    for (const command of ['stand', 'sit', 'kneel'] as const) {
      assert.equal(forbidden(command), false, command);
    }
    for (const command of ['rest', 'sleep'] as const) {
      assert.equal(forbidden(command), true, command);
    }
  });

  it('lets you flee through a door but not slam it behind you', () => {
    assert.equal(forbidden('open'), false);
    assert.equal(forbidden('close'), true);
  });

  it('refuses `who`, though it works while dead', () => {
    // Pure interface, available at the floor of the status ladder, and still refused mid-swing. The
    // source's judgement is that a global out-of-world scan is not a thing you do in a fight.
    assert.equal(COMMAND_REQUIREMENTS.who.status, 'dead');
    assert.equal(forbidden('who'), true);
  });

  it('lets you take armour off mid-fight but not put it on', () => {
    // 15b's sharpest row, and transcribed rather than chosen: `interp.c` registers `CMD_N(CMD_WEAR)`
    // and `CMD_Y(CMD_REMOVE)`. Not an inconsistency — shedding a thing is one motion and donning it is
    // several — and it is what stops a fight being paused to re-kit.
    assert.equal(forbidden('wear'), true);
    assert.equal(forbidden('remove'), false);
  });

  it('lets you grab, drop and check your bag while swinging', () => {
    // All three are `CMD_Y`. Dropping in particular is the classic thing a cornered character does,
    // and it is allowed from the floor: `CMD_Y(CMD_DROP, STAT_RESTING + POS_PRONE)`.
    for (const command of ['get', 'drop', 'inventory', 'loot'] as const) {
      assert.equal(forbidden(command), false, command);
    }
    assert.equal(COMMAND_REQUIREMENTS.drop.posture, 'prone');
    assert.equal(COMMAND_REQUIREMENTS.inventory.posture, 'prone');
  });
});

describe('splitCommand', () => {
  it('splits on the first run of whitespace and trims both halves', () => {
    assert.deepEqual(splitCommand('say hello there'), { word: 'say', rest: 'hello there' });
    assert.deepEqual(splitCommand('  look   2.torch  '), { word: 'look', rest: '2.torch' });
    assert.deepEqual(splitCommand('exits'), { word: 'exits', rest: '' });
    assert.deepEqual(splitCommand('   '), { word: '', rest: '' });
  });

  it('keeps the interior of the argument intact', () => {
    // `say` hands its rest through verbatim, so collapsing inner spacing here would rewrite what
    // players typed at each other.
    assert.equal(splitCommand('say  two   spaces').rest, 'two   spaces');
  });
});

describe('parseTargetRef — ordinals', () => {
  it('reads a bare keyword as the first of its kind', () => {
    assert.deepEqual(parseTargetRef('orc'), { keyword: 'orc', ordinal: 1 });
    assert.deepEqual(parseTargetRef('  ORC '), { keyword: 'orc', ordinal: 1 });
  });

  it('reads an ordinal prefix', () => {
    assert.deepEqual(parseTargetRef('2.orc'), { keyword: 'orc', ordinal: 2 });
    assert.deepEqual(parseTargetRef('10.torch'), { keyword: 'torch', ordinal: 10 });
  });

  it('refuses a malformed ordinal instead of falling back to the first match', () => {
    // `get_number` answers 0 here and every caller reads 0 as "nothing can match". Falling back to 1
    // would have a typo silently target whatever the room happened to list first — which, once
    // `kill` is real, is the difference between a typo and a fight.
    assert.equal(parseTargetRef('foo.orc'), undefined);
    assert.equal(parseTargetRef('.orc'), undefined);
    assert.equal(parseTargetRef('0.orc'), undefined, 'there is no zeroth orc');
    assert.equal(parseTargetRef('2.'), undefined, 'an ordinal with nothing to count');
    assert.equal(parseTargetRef('-1.orc'), undefined);
    assert.equal(parseTargetRef(''), undefined);
  });
});

describe('isName — whole word, never abbreviated', () => {
  it('matches a whole keyword regardless of case', () => {
    assert.equal(isName('torch', ['pitch-soaked', 'torch']), true);
    assert.equal(isName('TORCH', ['torch']), true);
  });

  it('refuses a prefix of a keyword', () => {
    // The rule that surprises people and is nonetheless right: commands abbreviate freely, content
    // keywords do not. `kill or` must not find an orc.
    assert.equal(isName('or', ['orc']), false);
    assert.equal(isName('torc', ['torch']), false);
  });

  it('refuses a keyword that merely contains the word', () => {
    assert.equal(isName('rch', ['torch']), false);
  });

  it('answers false for nothing at all', () => {
    assert.equal(isName('', ['torch']), false);
    assert.equal(isName('   ', ['torch']), false);
    assert.equal(isName('torch', []), false);
  });
});

describe('keywordsFromName', () => {
  it('drops the article and the noise words', () => {
    assert.deepEqual(keywordsFromName('a pitch-soaked torch'), ['pitch-soaked', 'torch']);
    assert.deepEqual(keywordsFromName('the Beacon of Hope'), ['beacon', 'hope']);
    assert.deepEqual(keywordsFromName('a stub of tallow candle'), ['stub', 'tallow', 'candle']);
  });

  it('handles a plain name', () => {
    assert.deepEqual(keywordsFromName('Alice'), ['alice']);
  });
});

describe('findTarget', () => {
  const room = [
    { name: 'an orc' },
    { name: 'a pitch-soaked torch' },
    { name: 'an orc chieftain' },
  ];
  const keywords = (thing: { name: string }) => keywordsFromName(thing.name);

  it('finds the first match for a bare keyword', () => {
    assert.equal(findTarget({ keyword: 'orc', ordinal: 1 }, room, keywords), room[0]);
  });

  it('counts only the things that match, in the order given', () => {
    // The torch sits between the two orcs, so an ordinal that counted list positions rather than
    // matches would find it — which is the bug this test exists for.
    assert.equal(findTarget({ keyword: 'orc', ordinal: 2 }, room, keywords), room[2]);
  });

  it('finds nothing past the end rather than wrapping or clamping', () => {
    assert.equal(findTarget({ keyword: 'orc', ordinal: 3 }, room, keywords), undefined);
    assert.equal(findTarget({ keyword: 'goblin', ordinal: 1 }, room, keywords), undefined);
  });

  it('respects the caller-supplied search order', () => {
    // The order is a gameplay decision — it is what makes `wear ring` take yours rather than the
    // floor's — so this must be the caller's to choose and this function's to obey.
    const reversed = [...room].reverse();
    assert.equal(findTarget({ keyword: 'orc', ordinal: 1 }, reversed, keywords), room[2]);
  });
});

describe('spendCommand — flood control', () => {
  it('allows a burst, then refuses', () => {
    const budget = newCommandBudget(1000);
    for (let i = 0; i < COMMAND_BURST; i++) {
      assert.equal(spendCommand(budget, 1000), true, `command ${i + 1} of the burst`);
    }
    assert.equal(spendCommand(budget, 1000), false, 'one past the burst');
  });

  it('refills one command per interval, capped at the burst', () => {
    const budget = newCommandBudget(1000);
    for (let i = 0; i < COMMAND_BURST; i++) spendCommand(budget, 1000);

    assert.equal(spendCommand(budget, 1000 + COMMAND_REFILL_MS - 1), false, 'not yet');
    assert.equal(spendCommand(budget, 1000 + COMMAND_REFILL_MS), true, 'one token back');
    assert.equal(spendCommand(budget, 1000 + COMMAND_REFILL_MS), false, 'and spent again');

    // A long idle refills to the cap and no further.
    const later = 1000 + COMMAND_REFILL_MS * 500;
    for (let i = 0; i < COMMAND_BURST; i++) {
      assert.equal(spendCommand(budget, later), true, `refilled command ${i + 1}`);
    }
    assert.equal(spendCommand(budget, later), false, 'the cap is the burst, not the idle time');
  });

  it('cannot be reset by a stream of sub-interval commands', () => {
    // The bug this guards: advancing `lastRefillMs` to *now* on every call throws away the remainder,
    // so a client sending every 249 ms would never accumulate a full interval and never be limited —
    // or, depending on which way it is written, would refill on every single call.
    const budget = newCommandBudget(0);
    for (let i = 0; i < COMMAND_BURST; i++) spendCommand(budget, 0);

    let allowed = 0;
    // 100 attempts at 10 ms apart is 1 s of wall time, which is worth exactly 4 refills.
    for (let i = 1; i <= 100; i++) {
      if (spendCommand(budget, i * 10)) allowed++;
    }
    assert.equal(allowed, Math.floor(1000 / COMMAND_REFILL_MS));
  });

  it('never runs the clock backwards on an out-of-order timestamp', () => {
    const budget = newCommandBudget(5000);
    spendCommand(budget, 5000);
    assert.doesNotThrow(() => spendCommand(budget, 0));
    assert.ok(budget.tokens >= 0);
  });
});

describe('whisper — owner-requested 2026-08-05', () => {
  it('lands on `whi`, and moves nothing above it', () => {
    // The abbreviation falls out of table order rather than being arranged: `w` is west and `wh` is
    // who, both above, and a rebound movement key is the one cost this table must never pay.
    assert.equal(lookupCommand('w'), 'west');
    assert.equal(lookupCommand('wh'), 'who');
    assert.equal(lookupCommand('whi'), 'whisper');
    assert.equal(lookupCommand('whisper'), 'whisper');
  });

  it('is stricter than `say` on both axes, which is the source’s call', () => {
    // `CMD_N(CMD_WHISPER, STAT_RESTING + POS_SITTING, …)`. Speaking aloud works flat on your back and
    // mid-swing; leaning in to murmur to one person needs you upright enough to lean, and is not
    // something you do while fighting.
    const floored = { posture: 'prone', status: 'resting' } as const;
    assert.ok(meets(floored, COMMAND_REQUIREMENTS.say), 'say works flat out');
    assert.ok(!meets(floored, COMMAND_REQUIREMENTS.whisper), 'whisper does not');
    assert.equal(COMMAND_REQUIREMENTS.say.inCombat, undefined, 'say is allowed mid-fight');
    assert.equal(COMMAND_REQUIREMENTS.whisper.inCombat, false, 'whisper is not');
  });
});

describe('junk — owner-requested 2026-08-05', () => {
  it('lands on `j`, and moves nothing above it', () => {
    // Nothing above starts with a `j`, so the shortest form reaches it. A single letter finding a
    // destructive verb would be alarming anywhere else; here it is safe by construction, because
    // `junk` never destroys anything on its own — it asks, and the answer is a second line.
    assert.equal(lookupCommand('j'), 'junk');
    assert.equal(lookupCommand('junk'), 'junk');
    // And the movement keys are untouched, which is the one cost this table may never pay.
    assert.equal(lookupCommand('n'), 'north');
    assert.equal(lookupCommand('d'), 'down');
  });

  it('is refused in combat and needs you sitting, which is `CMD_CNF_N`’s other half', () => {
    // `CMD_CNF_N(CMD_JUNK, STAT_RESTING + POS_SITTING, do_junk, 56)` — transcribed. It sits beside
    // `wear` and `put` as a thing you do not do mid-swing.
    assert.equal(COMMAND_REQUIREMENTS.junk?.inCombat, false);
    const floored = { posture: 'prone', status: 'resting' } as const;
    assert.equal(meets(floored, COMMAND_REQUIREMENTS.junk), false, 'not flat on your back');
    const sitting = { posture: 'sitting', status: 'resting' } as const;
    assert.ok(meets(sitting, COMMAND_REQUIREMENTS.junk));
  });
});

describe('follow — Phase 18', () => {
  it('lands on `fo`, leaving flee on the letter a cornered player reaches for', () => {
    assert.equal(lookupCommand('f'), 'flee');
    assert.equal(lookupCommand('fl'), 'flee');
    assert.equal(lookupCommand('fo'), 'follow');
    assert.equal(lookupCommand('follow'), 'follow');
  });

  it('may be typed mid-fight, which is the source’s own call', () => {
    // `CMD_Y(CMD_FOLLOW, STAT_RESTING + POS_SITTING, …)`. Deciding who to walk behind is allowed
    // while fighting — it is the only way to arrange a retreat with somebody while the fight that
    // makes you want one is still going on. Walking is still refused; `flee` is still the way out.
    assert.equal(COMMAND_REQUIREMENTS.follow?.inCombat, undefined);
    const floored = { posture: 'prone', status: 'resting' } as const;
    assert.equal(meets(floored, COMMAND_REQUIREMENTS.follow), false, 'but not flat on your back');
  });
});
