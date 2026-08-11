/**
 * Choosing a creature's look from its name.
 *
 * The two halves worth pinning are the ones a bulk run of 1,500 makes expensive to get wrong: a
 * word matcher that fires on a substring quietly turns orchard keepers into orcs, and an answer
 * reader that guesses turns a model's hedge into a recorded decision.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_BODY,
  bodyFromWords,
  buildMobPrompt,
  plainName,
  readMobAnswer,
  readSpriteKey,
  shapeFromWords,
  spriteKey,
  type MobFacts,
} from './mobpick.ts';

const SHAPES = [
  'human', 'lizard', 'wolf', 'rabbit', 'rat', 'mouse', 'pig', 'boarman', 'sheep',
  'minotaur', 'goblin', 'orc', 'troll', 'skeleton', 'zombie', 'vampire', 'alien',
];
const BODIES = ['male', 'female', 'muscular', 'child', 'teen', 'skeleton', 'zombie'];

const mob = (name: string, over: Partial<MobFacts> = {}): MobFacts => ({ vnum: 1, name, ...over });

describe('what a creature calls itself', () => {
  it('strips the MUD colour codes before matching a word', () => {
    assert.equal(plainName('&+La &+rbloody&+L kobold&N'), 'a bloody kobold');
  });

  it('reads a kobold as a lizard, which is 42 of the world on its own', () => {
    // Duris files kobolds under race code H, the same as every human in the game. The name is the
    // only thing that knows, which is the whole argument for matching on it.
    assert.equal(shapeFromWords(mob('the kobold shaman', { race: 'H' }), SHAPES), 'lizard');
    assert.equal(shapeFromWords(mob('a kobold youth'), SHAPES), 'lizard');
  });

  it('settles the obvious ones without troubling a model', () => {
    for (const [name, shape] of [
      ['a grey wolf', 'wolf'], ['a worg rider', 'wolf'], ['a wild rabbit', 'rabbit'],
      ['a giant rat', 'rat'], ['an orc sergeant', 'orc'], ['a hobgoblin', 'goblin'],
      ['a cave troll', 'troll'], ['a skeletal warrior', 'skeleton'], ['a rotting ghoul', 'zombie'],
    ] as const) {
      assert.equal(shapeFromWords(mob(name), SHAPES), shape, name);
    }
  });

  it('matches whole words, so an orchard keeper is not an orc', () => {
    // The mistake that makes a bulk assignment untrustworthy, and the one nobody spots in a list of
    // 1,500 rows. A prefix matcher gets every one of these wrong.
    assert.equal(shapeFromWords(mob('an orchard keeper'), SHAPES), undefined);
    assert.equal(shapeFromWords(mob('a ratchet seller'), SHAPES), undefined);
    assert.equal(shapeFromWords(mob('the Trollop of Velen'), SHAPES), undefined);
    assert.equal(shapeFromWords(mob('a piglet farmer'), SHAPES), undefined);
  });

  it('says nothing about an ordinary person, leaving them for the model or the default', () => {
    assert.equal(shapeFromWords(mob('a bored palace guard'), SHAPES), undefined);
    assert.equal(shapeFromWords(mob('Sysoria, the faerie Princess'), SHAPES), undefined);
  });

  it('will not offer a shape the pack does not have', () => {
    // The catalogue is generated, so the vocabulary can shrink. Offering a missing shape would put
    // an id in the data that stages to nothing and draws magenta.
    assert.equal(shapeFromWords(mob('a grey wolf'), ['human', 'lizard']), undefined);
  });

  it('reads the keywords as well as the name, because the harvest puts the noun there', () => {
    assert.equal(shapeFromWords(mob('Grimfang', { keywords: ['grimfang', 'wolf'] }), SHAPES), 'wolf');
  });
});

describe('what build it gets', () => {
  it('makes the big ones big and the small ones small', () => {
    assert.equal(bodyFromWords(mob('a hulking ogre'), BODIES), 'muscular');
    assert.equal(bodyFromWords(mob('a kobold youth'), BODIES), 'child');
    assert.equal(bodyFromWords(mob('an apprentice mage'), BODIES), 'teen');
  });

  it('defaults rather than inventing, because a name rarely states a build', () => {
    assert.equal(bodyFromWords(mob('a travelling merchant'), BODIES), DEFAULT_BODY);
  });

  it('falls back to something real when the default is not offered', () => {
    assert.equal(bodyFromWords(mob('a merchant'), ['female']), 'female');
  });
});

describe('the prompt', () => {
  const prompt = buildMobPrompt(
    mob('&+La scaled hunter&N', { keywords: ['scaled', 'hunter'], race: 'H', level: 12 }),
    SHAPES,
  );

  it('hands over the whole candidate list, because a model asked for "a head" invents one', () => {
    for (const shape of SHAPES) assert.ok(prompt.includes(shape), `missing ${shape}`);
  });

  it('gives the model everything the template actually has', () => {
    assert.ok(prompt.includes('a scaled hunter'), 'the plain name');
    assert.ok(!prompt.includes('&+L'), 'and not the colour codes');
    assert.ok(prompt.includes('scaled, hunter'));
    assert.ok(prompt.includes('H'));
    assert.ok(prompt.includes('12'));
  });

  it('states the plainness rule, which is the failure mode of a creative model here', () => {
    // Most of this world is people. A roster where every guard is a minotaur is worse than one
    // where every guard is a man, so the instruction is explicit rather than hoped for.
    assert.match(prompt, /ordinary people/);
    assert.match(prompt, /answer human/);
  });

  it('omits a line it has no fact for rather than saying "undefined"', () => {
    const bare = buildMobPrompt(mob('a shadow'), SHAPES);
    assert.ok(!bare.includes('Keywords:'));
    assert.ok(!bare.includes('Race code:'));
    assert.ok(!bare.toLowerCase().includes('undefined'));
  });
});

describe('reading the answer back', () => {
  it('takes a bare word', () => {
    assert.equal(readMobAnswer('wolf', SHAPES), 'wolf');
    assert.equal(readMobAnswer('  LIZARD\n', SHAPES), 'lizard');
  });

  it('finds the choice inside a sentence, because small models add one', () => {
    assert.equal(readMobAnswer('I would choose wolf for this creature.', SHAPES), 'wolf');
  });

  it('refuses an answer naming two shapes rather than guessing', () => {
    // A coin toss recorded as a decision is the one thing a bulk sweep must never do - it is
    // indistinguishable from a real choice afterwards.
    assert.equal(readMobAnswer('either wolf or rat', SHAPES), undefined);
  });

  it('refuses an invented shape', () => {
    assert.equal(readMobAnswer('badger', SHAPES), undefined);
    assert.equal(readMobAnswer('', SHAPES), undefined);
  });
});

describe('the sprite key', () => {
  it('round-trips', () => {
    assert.equal(spriteKey({ body: 'muscular', head: 'wolf' }), 'muscular/wolf');
    assert.deepEqual(readSpriteKey('muscular/wolf'), { body: 'muscular', head: 'wolf' });
  });

  it('refuses a key that is not two parts, so a bad override degrades to the human', () => {
    assert.equal(readSpriteKey('human'), undefined);
    assert.equal(readSpriteKey(''), undefined);
  });
});
