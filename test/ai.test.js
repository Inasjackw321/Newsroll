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

test('prompts number the stories and include an example and the date', () => {
  const story = { title: 'A', source: 'S', summary: 'x', published: new Date().toISOString() };
  const summary = ai.summaryPrompt([story], 'today');
  assert.match(summary[1].content, /^Stories for today:\n\[1\] A \(S, just now\)/);
  const ask = ai.askPrompt('What is A?', [story], [{ q: 'earlier', a: 'reply' }]);
  assert.match(ask[0].content, /Today is /);
  assert.match(ask[0].content, /Example answer/);
  assert.deepStrictEqual(ask.slice(1, 3).map((m) => m.role), ['user', 'assistant']); // history comes first
  assert.match(ask.at(-1).content, /Question: What is A\?$/);
});
