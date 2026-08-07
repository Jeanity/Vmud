/**
 * Reading the item catalogue.
 *
 * The fixture is `#420000` from `IC3.obj` copied verbatim — a real record rather than an invented one,
 * because the whole risk in this parser is that a plausible-looking layout is not the layout the files
 * actually use.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadObjects, parseObjectFile, parseObjectRecord, toTemplate } from './objects.ts';

const dir = mkdtempSync(join(tmpdir(), 'mygame-obj-'));
function write(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text, 'latin1');
  return path;
}

/** `IC3.obj`'s first record, unedited. */
const KHOPIS = `#420000
khopis shortsword windrage _id_~
&+Ca khopis shortsword named '&+WW&+ci&+wn&+WdR&+ca&+wg&+We&+C'&n~
&+CA legendary blade called '&+WW&+ci&+wn&+WdR&+ca&+wg&+We&+C' lies here on the ground.&n~
~
5 18 3 0 15 0 101724433 8413185 125 534712316 256
9 5 5 0 0 589 46 45
0 5000000 100
E
_id_name_~
~
A
18 6
A
19 5
`;

const QUIVER = `#420003
quiver mithril glowing red~
&+ma quiver of mithril &+Rglowing red&n~
&+mA mysterious quiver &+Rglowing red&+m, lies here in the &+ydust&+m.&n~
~
30 18 2 0 14 0 33566721 5259265 0 0 0
200 0 1 0 0 0 0 0
0 0 100 134217728 2048 0 0
A
58 -1
A
32 3
`;

describe('one object record', () => {
  it('reads the four strings, the type, the flags and the values', () => {
    const parsed = parseObjectRecord(420_000, KHOPIS.slice(KHOPIS.indexOf('\n') + 1));
    assert.ok(parsed);
    assert.deepEqual(parsed.keywords, ['khopis', 'shortsword', 'windrage', '_id_']);
    assert.equal(parsed.type, 5, 'ITEM_WEAPON');
    assert.equal(parsed.extraFlags, 101_724_433);
    assert.equal(parsed.wearFlags, 8_413_185);
    assert.deepEqual([...parsed.values], [9, 5, 5, 0, 0, 589, 46, 45]);
    assert.equal(parsed.weight, 0);
    assert.equal(parsed.cost, 5_000_000);
  });

  it('skips the three fields the source itself throws away, by position', () => {
    // `read_object` reads `obj->size`, `obj->space` and `damres_bonus` and has all three commented out.
    // They sit at positions 2, 3 and 5 of the header row, so the flags are at 6 and 7 — get the count
    // wrong and `extra_flags` reads as a craftsmanship rating, which is a plausible-looking number.
    const parsed = parseObjectRecord(420_000, KHOPIS.slice(KHOPIS.indexOf('\n') + 1));
    assert.equal(parsed!.extraFlags, 101_724_433, 'position 6, past material/size/space/craft/damres');
  });

  it('reads the numeric run across line breaks, the way fscanf does', () => {
    // **The trap.** The source reads these with `fscanf(" %d ")`, which skips newlines like any other
    // whitespace, so a file may wrap them anywhere. Parsing line-by-line works on the conventional
    // layout and silently misreads the rest.
    const oneLine = KHOPIS.replace(
      '5 18 3 0 15 0 101724433 8413185 125 534712316 256\n9 5 5 0 0 589 46 45\n0 5000000 100',
      '5 18 3 0 15 0 101724433 8413185 125 534712316 256 9 5 5 0 0 589 46 45 0 5000000 100',
    );
    const a = parseObjectFile(write('wrapped.obj', KHOPIS));
    const b = parseObjectFile(write('flat.obj', oneLine));
    assert.deepEqual(a, b, 'where the line breaks fall changes nothing');
  });

  it('reads the A blocks, which is where a magic item keeps its bonuses', () => {
    const parsed = parseObjectRecord(420_000, KHOPIS.slice(KHOPIS.indexOf('\n') + 1));
    assert.deepEqual(parsed!.affects, [
      { location: 18, modifier: 6 },
      { location: 19, modifier: 5 },
    ]);
  });

  it('is not confused by the optional bitvector row some files carry and some do not', () => {
    // The quiver's tail is `0 0 100 134217728 2048 0 0` — weight, cost, condition, then four bitvectors
    // that only some records have. Reading a fixed count from the end would take a bitvector for a cost.
    const parsed = parseObjectFile(write('quiver.obj', QUIVER))[0];
    assert.ok(parsed);
    assert.equal(parsed.type, 30, 'ITEM_QUIVER');
    assert.equal(parsed.weight, 0);
    assert.equal(parsed.cost, 0);
    assert.equal(parsed.values[0], 200, 'its capacity');
  });

  it('refuses a truncated record rather than inventing fields', () => {
    assert.equal(parseObjectRecord(1, 'only~ two~ strings~\n'), undefined);
    assert.equal(parseObjectRecord(1, 'a~\nb~\nc~\nd~\n5 18 3\n'), undefined, 'too few numbers');
  });

  it('harvests what a scroll recites — level, spells, duplicates kept, empty slots dropped', () => {
    // `#97558` from `shady.obj`, unedited: **a scroll of ice**. Its values are `25 8 8 -1 …` —
    // level 25, chill touch (Duris spell 8) stored TWICE, then the `-1` empty-slot marker
    // `do_recite` skips with its `value[i] >= 1` gate. The duplicate is the interesting half:
    // a slot is a casting, not a set, and this scroll legitimately casts chill touch twice.
    const parsed = parseObjectRecord(
      97_558,
      'scroll ice~\n&+Wa scroll of ice&N~\nAn unwanted scroll collects among the rubble here.~\n~\n2 29 1 2 7 0 0 16385 0 0 0\n25 8 8 -1 0 0 0 0\n1 30999 100\n',
    );
    assert.ok(parsed);
    const template = toTemplate(parsed);
    assert.ok(template);
    assert.deepEqual(template.scroll, { level: 25, spells: [8, 8] });
  });

  it('puts no recitation on anything that is not a scroll', () => {
    const parsed = parseObjectRecord(420_000, KHOPIS.slice(KHOPIS.indexOf('\n') + 1));
    const template = toTemplate(parsed!);
    assert.ok(template);
    assert.equal(template.scroll, undefined);
  });
});

describe('a directory of them', () => {
  it('joins by vnum across files, with a stable last-wins rule', () => {
    // Several `.obj` files are older copies of a zone kept beside the live one, so duplicate vnums are
    // real. Which side wins matters less than the rule being stable — files are read in sorted order.
    write('a_dup.obj', KHOPIS);
    write('z_dup.obj', KHOPIS.replace('khopis shortsword windrage', 'newer version'));
    const objects = loadObjects(dir);
    assert.equal(objects.get(420_000)?.keywords[0], 'newer', 'the later filename wins');
  });

  it('reads every record in a file, not just the first', () => {
    const two = write('two.obj', `${KHOPIS}${QUIVER}$~\n`);
    assert.deepEqual(parseObjectFile(two).map((o) => o.vnum), [420_000, 420_003]);
  });

  it('stops at the file terminator rather than reading a builder’s scratch notes', () => {
    const trailing = write('tail.obj', `${KHOPIS}$~\n#999999\njunk~\njunk~\njunk~\n~\n1 1 1 1 1 1 1 1 1 1 1\n0 0 0 0 0 0 0 0\n0 0 0\n`);
    assert.deepEqual(parseObjectFile(trailing).map((o) => o.vnum), [420_000]);
  });
});
