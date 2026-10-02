const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEWSROLL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'newsroll-settings-'));
const settings = require('../lib/settings');
const { CATALOG } = require('../lib/catalog');

test('catalogue has unique ids and a sensible default set', () => {
  const ids = new Set(CATALOG.map((c) => c.id));
  assert.strictEqual(ids.size, CATALOG.length);
  assert.ok(CATALOG.length > 150);
  const on = CATALOG.filter((c) => c.defaultOn).length;
  assert.ok(on >= 10 && on <= 40);
  assert.ok(CATALOG.some((c) => c.type === 'telegram'));
});

test('toggling, adding and removing sources persists to disk', () => {
  const first = settings.sources()[0];
  settings.setEnabled([first.id], !first.enabled);
  const added = settings.addCustom({ id: 'custom-x', name: 'X', url: 'https://x.example/feed', type: 'rss' });
  assert.strictEqual(added.group, 'Added by you');

  settings.reset(); // re-read from disk
  assert.strictEqual(settings.sources().find((s) => s.id === first.id).enabled, !first.enabled);
  assert.ok(settings.enabledSources().some((s) => s.id === 'custom-x'));

  // Adding the same URL again just switches it on instead of duplicating it.
  settings.setEnabled(['custom-x'], false);
  const again = settings.addCustom({ id: 'custom-y', name: 'Y', url: 'https://X.example/feed', type: 'rss' });
  assert.ok(again.existed);
  assert.strictEqual(settings.sources().filter((s) => s.url.toLowerCase() === 'https://x.example/feed').length, 1);

  settings.removeCustom('custom-x');
  assert.ok(!settings.sources().some((s) => s.id === 'custom-x'));
});

test('remembers the chosen AI model', () => {
  assert.strictEqual(settings.getModel(), 'smollm2');
  settings.setModel('llama3.2');
  settings.reset();
  assert.strictEqual(settings.getModel(), 'llama3.2');
});

test('saves pinned variables and drops invalid ones', () => {
  const saved = settings.setVariables([
    { id: 'v1', name: 'Drone strikes', keywords: ['Drone', ' UAV '] },
    { name: '', keywords: ['x'] },
    { name: 'No keywords', keywords: [] },
  ]);
  assert.deepStrictEqual(saved, [{ id: 'v1', name: 'Drone strikes', keywords: ['drone', 'uav'] }]);
  settings.reset();
  assert.deepStrictEqual(settings.getVariables(), saved);
});
