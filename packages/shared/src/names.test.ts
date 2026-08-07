/**
 * The character name law. The owner's two examples are tested verbatim — if either ever passes,
 * the normaliser has regressed on exactly the case the rule was written for.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_CHARACTER_NAME,
  canonicalCharacterName,
  characterNameProblem,
  normaliseForMatching,
} from './names.ts';

const fine = (name: string): void => assert.equal(characterNameProblem(name), undefined, name);
const refused = (name: string): void => assert.notEqual(characterNameProblem(name), undefined, name);

describe('structure — transcribed from _parse_name', () => {
  it('letters only: no numbers, spaces, or marks', () => {
    refused('Weststar2');
    refused('West star');
    refused("D'artan");
    refused('West-Star');
    refused('Wést');
    fine('Weststar');
  });

  it('holds the source length lines: 2 to 12', () => {
    refused('A');
    fine('Al');
    fine('a'.repeat(MAX_CHARACTER_NAME));
    refused('a'.repeat(MAX_CHARACTER_NAME + 1));
  });

  it('refuses the reserved words the parser needs', () => {
    refused('self');
    refused('North');
    refused('me');
    refused('somebody');
    refused('female');
  });
});

describe('taste — the owner’s rule, 2026-08-08', () => {
  it('refuses the owner’s own two examples, verbatim', () => {
    refused('Schitthead');
    refused('PhuckPhace');
  });

  it('refuses the plain words and the evasion spellings alike', () => {
    refused('Fuckwit');
    refused('Phukker');
    refused('Shythead');
    refused('Schitt');
    refused('Kuntish');
    refused('Asshatt');
    refused('Wanker');
  });

  it('does not maim honest names for their letters', () => {
    fine('Cassandra'); // carries "ass" and keeps it
    fine('Bassim');
    fine('Bhorel'); // carries "hore" and keeps it
    fine('Titania'); // "tit" is exact-only
    fine('Gaylen'); // "gay" is exact-only
    fine('Dikembe');
    fine('Aldric');
    fine('Brynn');
  });

  it('refuses the well-known names, whatever the casing', () => {
    refused('Drizzt');
    refused('DRIZZT');
    refused('drizzt');
    refused('Elminster');
    refused('Bruenor');
    refused('Mystra');
    refused('Raistlin');
    refused('Astarion');
    refused('Mordenkainen');
  });

  it('leaves near-misses alone — homage is spelling your own name', () => {
    fine('Bruen');
    fine('Drizz'); // four letters of admiration, none of the trademark
    fine('Elmin');
  });
});

describe('the normaliser', () => {
  it('folds the classic evasions onto their roots', () => {
    assert.equal(normaliseForMatching('Schitthead').includes('shit'), true);
    assert.equal(normaliseForMatching('PhuckPhace').includes('fuk'), true);
    assert.equal(normaliseForMatching('Shyt').includes('shit'), true);
  });
});

describe('the canonical spelling', () => {
  it('caps the first letter and calms the rest', () => {
    assert.equal(canonicalCharacterName('weststar'), 'Weststar');
    assert.equal(canonicalCharacterName('WESTSTAR'), 'Weststar');
    assert.equal(canonicalCharacterName('  weststar  '), 'Weststar');
    assert.equal(canonicalCharacterName(''), '');
  });
});
