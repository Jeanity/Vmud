import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings.ts';

function tempFile(contents?: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'mygame-settings-')), 'settings.json');
  if (contents !== undefined) writeFileSync(file, contents, 'utf8');
  return file;
}

describe('world settings', () => {
  it('is off by default, which is the whole point of the switch existing', () => {
    // Owner's rule (2026-08-03): *"this is not a pkill game."* Nothing refused player-vs-player
    // combat before this file, so the default is a fix rather than a preference.
    assert.equal(DEFAULT_SETTINGS.pvp, false);
    assert.equal(loadSettings(tempFile()).pvp, false, 'and a missing file reads as off');
  });

  it('survives a restart, which is the reason it is a file', () => {
    const file = tempFile();
    saveSettings({ pvp: true, movementCosts: false }, file);
    assert.equal(loadSettings(file).pvp, true);
    assert.equal(loadSettings(file).movementCosts, false);
  });

  it('reads only a real `true` as on', () => {
    // These files are hand-editable. A `"yes"` or a `1` looks like consent and is not — and the safe
    // reading of a malformed dangerous flag is off, because the cost of guessing wrong is somebody
    // being killed by a rule nobody meant to be in force.
    for (const junk of ['"true"', '1', '"on"', 'null', '"yes"']) {
      assert.equal(loadSettings(tempFile(`{"pvp": ${junk}}`)).pvp, false, junk);
    }
    assert.equal(loadSettings(tempFile('{"pvp": true}')).pvp, true);
  });

  it('charges for movement unless the file says `false`, exactly — the mirrored polarity', () => {
    // The mirror of the pvp rule, because the danger is mirrored: costs are the shipped mechanic,
    // and a malformed value must not quietly hand out a free world.
    assert.equal(DEFAULT_SETTINGS.movementCosts, true);
    assert.equal(loadSettings(tempFile()).movementCosts, true, 'a missing file charges');
    for (const junk of ['"false"', '0', '"off"', 'null', '"no"']) {
      assert.equal(loadSettings(tempFile(`{"movementCosts": ${junk}}`)).movementCosts, true, junk);
    }
    assert.equal(loadSettings(tempFile('{"movementCosts": false}')).movementCosts, false);
  });

  it('shrugs at a corrupt file rather than refusing to boot', () => {
    assert.deepEqual(loadSettings(tempFile('{ not json')), DEFAULT_SETTINGS);
    assert.deepEqual(loadSettings(tempFile('[]')), DEFAULT_SETTINGS);
  });
});
