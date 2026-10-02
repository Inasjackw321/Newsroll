const test = require('node:test');
const assert = require('node:assert');
const { rankImportance } = require('../lib/importance');

const now = Date.parse('2026-10-02T12:00:00Z');
const at = (h) => new Date(now - h * 3600e3).toISOString();
const it = (id, title, source, hours = 1) => ({ id, title, source, summary: '', published: at(hours) });

test('stories covered by several outlets and with urgent wording rank higher', () => {
  const items = rankImportance([
    it('1', 'Breaking: drone strikes hit power stations overnight', 'A', 0.5),
    it('2', 'Drone strikes hit power stations, officials say', 'B'),
    it('3', 'Overnight drone strikes hit power stations', 'C'),
    it('4', 'Local bakery wins national award', 'D'),
    it('5', 'Earthquake shakes coastal city', 'E', 10),
  ], new Map(), now);
  const byId = Object.fromEntries(items.map((x) => [x.id, x]));
  assert.strictEqual(byId['1'].coverage, 3);
  assert.strictEqual(byId['1'].importance, 2);
  assert.ok(byId['1'].breaking);
  assert.ok(byId['2'].importance >= 1);
  assert.strictEqual(byId['4'].importance, 0);
  assert.strictEqual(byId['4'].coverage, 1);
  assert.strictEqual(byId['5'].importance, 0); // one serious word alone isn't enough
  assert.ok(!byId['5'].breaking);
});

test('merged duplicate headlines count towards coverage', () => {
  const [one] = rankImportance([it('1', 'Earthquake shakes coastal city', 'A')], new Map([['1', 3]]), now);
  assert.strictEqual(one.coverage, 4);
  assert.ok(one.importance >= 1);
});
