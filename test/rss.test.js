const test = require('node:test');
const assert = require('node:assert');
const { parseFeed } = require('../lib/rss');
const { tagTopic } = require('../lib/topics');

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Example News</title>
<item>
  <title><![CDATA[Stocks rally as inflation &amp; rates fall]]></title>
  <link>https://example.com/a</link>
  <description>&lt;p&gt;Markets rose &lt;b&gt;sharply&lt;/b&gt; on Tuesday.&lt;/p&gt;</description>
  <pubDate>Tue, 29 Sep 2026 10:00:00 GMT</pubDate>
  <media:thumbnail url="https://example.com/a.jpg" width="240"/>
</item>
<item><title>Second story</title><guid>https://example.com/b</guid></item>
<item><description>No title, skipped</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title>
<entry><title type="html">Scientists find water on Mars</title>
<link rel="alternate" href="https://example.com/mars"/><updated>2026-09-30T08:30:00Z</updated>
<summary>A big discovery.</summary></entry></feed>`;

test('parses RSS items, decoding CDATA, entities and HTML', () => {
  const items = parseFeed(RSS, 'Example');
  assert.strictEqual(items.length, 2);
  const [a, b] = items;
  assert.strictEqual(a.title, 'Stocks rally as inflation & rates fall');
  assert.strictEqual(a.summary, 'Markets rose sharply on Tuesday.');
  assert.strictEqual(a.link, 'https://example.com/a');
  assert.strictEqual(a.image, 'https://example.com/a.jpg');
  assert.strictEqual(a.published, '2026-09-29T10:00:00.000Z');
  assert.strictEqual(a.source, 'Example');
  assert.match(a.id, /^[0-9a-f]{10}$/);
  assert.strictEqual(b.link, 'https://example.com/b');
  assert.strictEqual(b.published, null);
});

test('parses Atom entries and falls back to the feed title as source', () => {
  const [entry] = parseFeed(ATOM);
  assert.strictEqual(entry.title, 'Scientists find water on Mars');
  assert.strictEqual(entry.link, 'https://example.com/mars');
  assert.strictEqual(entry.source, 'Atom Feed');
  assert.strictEqual(entry.published, '2026-09-30T08:30:00.000Z');
});

test('tags topics from keywords', () => {
  assert.strictEqual(tagTopic({ title: 'Stocks rally as inflation falls', summary: '' }), 'Business');
  assert.strictEqual(tagTopic({ title: 'Scientists find water on Mars', summary: '' }), 'Science');
  assert.strictEqual(tagTopic({ title: 'New AI chip unveiled', summary: '' }), 'Tech');
  assert.strictEqual(tagTopic({ title: 'Local bakery opens', summary: '' }), 'General');
  // "ai" must be a whole word, not part of "said" or "Spain".
  assert.notStrictEqual(tagTopic({ title: 'Spain said to plan holiday', summary: '' }), 'Tech');
});
