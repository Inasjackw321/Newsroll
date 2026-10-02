const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

// A fake Ollama that streams NDJSON like the real /api/chat endpoint.
const mock = http.createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.end(JSON.stringify({ models: [{ name: 'smollm2:latest' }] }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    mock.lastRequest = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const word of ['Hello', ' from', ' the [1]', ' model.']) {
      res.write(JSON.stringify({ message: { role: 'assistant', content: word }, done: false }) + '\n');
    }
    res.end(JSON.stringify({ done: true }) + '\n');
  });
});

let ai;
test.before(async () => {
  process.env.NEWSROLL_DATA = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'newsroll-test-'));
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_HOST = `http://127.0.0.1:${mock.address().port}`;
  ai = require('../lib/ai');
});
test.after(() => mock.close());

test('reports model status from /api/tags', async () => {
  const s = await ai.status();
  assert.strictEqual(s.online, true);
  assert.strictEqual(s.installed, true);
  assert.strictEqual(s.model, 'smollm2');
});

test('streams tokens from /api/chat', async () => {
  let out = '';
  await ai.streamChat([{ role: 'user', content: 'hi' }], (t) => (out += t));
  assert.strictEqual(out, 'Hello from the [1] model.');
  assert.strictEqual(mock.lastRequest.model, 'smollm2');
  assert.strictEqual(mock.lastRequest.stream, true);
});

test('ranks stories by relevance to the question', () => {
  const items = [
    { id: '1', title: 'Football final ends in penalties', summary: '', topic: 'Sports' },
    { id: '2', title: 'Central bank holds interest rates', summary: 'Inflation is easing', topic: 'Business' },
    { id: '3', title: 'New phone launched', summary: '', topic: 'Tech' },
  ];
  assert.strictEqual(ai.rankByRelevance('What is happening with inflation and interest rates?', items)[0].id, '2');
  // No keyword match falls back to the latest stories.
  assert.strictEqual(ai.rankByRelevance('Anything else?', items).length, 3);
});

test('prompts number the stories for citation', () => {
  const msgs = ai.summaryPrompt([{ title: 'A', source: 'S', summary: 'x', published: new Date().toISOString() }], 'today');
  assert.match(msgs[1].content, /^Stories for today:\n\[1\] \(S, .*\) A — x/);
});
