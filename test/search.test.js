const test = require('node:test');
const assert = require('node:assert');
const { search, stem } = require('../lib/search');
const { classify, evalMath, isFollowUp } = require('../lib/intent');

const now = Date.parse('2026-10-02T12:00:00Z');
const ago = (h) => new Date(now - h * 3600e3).toISOString();
let n = 0;
const story = (title, summary = '', source = `Source ${n % 5}`, hours = n) => ({ id: String(++n), title, summary, source, published: ago(hours), topic: 'General' });

const items = [
  story('Goalie Shesterkin notches empty-netter in Rangers victory', 'The New York Rangers beat the Devils 4-2.'),
  story("Mike Tomlin's 12-year Minecraft city stuns fans", 'The Steelers head coach revealed a longtime hobby.'),
  story('Israeli strikes hit southern Lebanon as Hezbollah fires rockets', 'Tensions rose along the border.'),
  story('Gaza ceasefire talks resume in Cairo', 'Negotiators from Hamas and Israel met with Egyptian mediators.'),
  story('Iran says it will respond to sanctions', 'Tehran criticised new measures.'),
  story('Fed holds interest rates steady as inflation cools', 'Markets rallied after the decision.'),
  story('Apple unveils new iPhone with on-device AI', 'The company showed new features.'),
  story('Storm forces thousands to evacuate in Florida', 'A hurricane warning is in effect.'),
  story('Local bakery wins national award', 'The shop has been open since 1950.'),
];

test('"middle east" finds stories about Israel, Gaza, Lebanon and Iran', () => {
  const r = search('Give me an update about the middle east', items, { now });
  assert.ok(r.matched);
  const titles = r.items.map((i) => i.title).join(' | ');
  for (const word of ['Lebanon', 'Gaza', 'Iran']) assert.match(titles, new RegExp(word));
  assert.ok(!/bakery|iPhone|Rangers/.test(titles), titles);
  assert.deepStrictEqual(r.groups, ['Middle East & Africa']);
});

test('names beat common words', () => {
  const r = search('what happened with Mike Tomlin', items, { now });
  assert.match(r.items[0].title, /Tomlin/);
});

test('topic words map to the stories that use other words', () => {
  assert.match(search("how's the economy doing?", items, { now }).items[0].title, /interest rates/);
  assert.match(search('any AI news', items, { now }).items[0].title, /iPhone/);
  assert.match(search('weather', items, { now }).items[0].title, /Storm/);
});

test('generic questions return the newest stories; unknown topics return nothing', () => {
  const latest = search("what's the latest?", items, { now });
  assert.ok(latest.generic && latest.items.length > 0);
  assert.strictEqual(latest.items[0].title, items[0].title);
  assert.strictEqual(search('Antarctic penguin census', items, { now }).matched, false);
});

test('stemming lines up word forms', () => {
  assert.strictEqual(stem('elections'), stem('election'));
  assert.strictEqual(stem('strikes'), stem('strike'));
  assert.strictEqual(stem('policies'), stem('policy'));
});

test('classifies questions and does maths exactly', () => {
  assert.strictEqual(classify('5 + 5'), 'math');
  assert.strictEqual(evalMath('5 + 5'), 10);
  assert.strictEqual(evalMath('what is (2 + 3) * 4?'), 20);
  assert.strictEqual(evalMath('2^3^2'), 512);
  assert.strictEqual(evalMath('1990'), null);
  assert.strictEqual(evalMath('5 +'), null);
  assert.strictEqual(classify('hello!'), 'greeting');
  assert.strictEqual(classify('what can you do'), 'help');
  assert.strictEqual(classify('Give me an update about the middle east'), 'news');
  assert.ok(isFollowUp('why?'));
  assert.ok(isFollowUp('tell me more'));
  assert.ok(!isFollowUp('What is happening with the Fed and inflation this week in the US?'));
});
