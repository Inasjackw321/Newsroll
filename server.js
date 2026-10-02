// Newsroll: a tiny RSS timeline server with local AI features via Ollama.
// No dependencies — just Node 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseFeed } = require('./lib/rss');
const { tagTopic } = require('./lib/topics');
const { sampleItems } = require('./lib/sample');
const ai = require('./lib/ai');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const MAX_ITEMS = 250;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

let cache = { items: [], fetchedAt: 0, errors: [], sample: false };
let inflight = null;

// The desktop app points NEWSROLL_FEEDS at an editable copy in the user's data folder.
function loadFeeds() {
  const file = process.env.NEWSROLL_FEEDS || path.join(__dirname, 'feeds.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'Newsroll/0.1 (+https://github.com/inasjackw321/newsroll)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text(), feed.name);
}

async function refresh() {
  const feeds = loadFeeds();
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const errors = [];
  const seen = new Set();
  let items = [];

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      errors.push({ feed: feeds[i].name, error: r.reason?.cause?.message || r.reason?.message || String(r.reason) });
      return;
    }
    for (const item of r.value) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  });

  const sample = items.length === 0;
  if (sample) items = sampleItems();

  const now = Date.now();
  items = items
    .map((it) => ({ ...it, published: it.published || new Date(now).toISOString(), topic: tagTopic(it) }))
    .filter((it) => now - Date.parse(it.published) < MAX_AGE_MS && Date.parse(it.published) <= now + 3600e3)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, MAX_ITEMS);

  cache = { items, fetchedAt: now, errors, sample, feeds: feeds.map((f) => f.name) };
  return cache;
}

async function getItems(force = false) {
  if (!force && cache.fetchedAt && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  if (!inflight) inflight = refresh().finally(() => (inflight = null));
  return inflight;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e5) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Streams model output as plain text. The stories the model was shown are sent
// up-front in a header so the client can turn [n] citations into links.
async function streamAi(req, res, messages, sources = []) {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Newsroll-Sources': sources.map((s) => s.id).join(','),
  });
  try {
    await ai.streamChat(messages, (token) => res.write(token), controller.signal);
  } catch (err) {
    if (!controller.signal.aborted) {
      const hint = /fetch failed|ECONNREFUSED/i.test(err.message + (err.cause?.message || ''))
        ? `Ollama isn't reachable. Start it with "ollama serve" and run "ollama pull ${process.env.OLLAMA_MODEL || 'smollm2'}".`
        : err.message;
      res.write(`\n\n⚠️ ${hint}`);
    }
  }
  res.end();
}

function pickItems(items, ids) {
  if (!Array.isArray(ids) || !ids.length) return items;
  const wanted = new Set(ids);
  return items.filter((it) => wanted.has(it.id));
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/feed') {
    const data = await getItems(url.searchParams.has('force'));
    return sendJson(res, 200, data);
  }

  if (req.method === 'GET' && url.pathname === '/api/ai/status') {
    return sendJson(res, 200, await ai.status());
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/ai/')) {
    const body = await readBody(req);
    const { items } = await getItems();
    const action = url.pathname.slice('/api/ai/'.length);

    if (action === 'summary') {
      const chosen = pickItems(items, body.ids).slice(0, ai.MAX_CONTEXT_STORIES);
      if (!chosen.length) return sendJson(res, 400, { error: 'No stories to summarise' });
      return streamAi(req, res, ai.summaryPrompt(chosen, String(body.label || 'today').slice(0, 60)), chosen);
    }

    if (action === 'ask') {
      const question = String(body.question || '').trim().slice(0, 500);
      if (!question) return sendJson(res, 400, { error: 'Question is required' });
      const chosen = ai.rankByRelevance(question, pickItems(items, body.ids));
      return streamAi(req, res, ai.askPrompt(question, chosen), chosen);
    }

    if (action === 'explain') {
      const item = items.find((it) => it.id === body.id);
      if (!item) return sendJson(res, 404, { error: 'Story not found' });
      return streamAi(req, res, ai.explainPrompt(item), [item]);
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

// Starts listening on 127.0.0.1. Resolves with the port actually used, so the
// desktop app can fall back to any free port if the preferred one is taken.
function start(port = PORT, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        server.removeListener('error', onError);
        resolve(start(0, host));
      } else reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      getItems().catch((err) => console.error('Initial feed load failed:', err.message));
      resolve(server.address().port);
    });
  });
}

if (require.main === module) {
  start(PORT, process.env.HOST || '127.0.0.1').then((port) => {
    console.log(`📰 Newsroll running at http://localhost:${port}`);
    ai.status().then((s) => {
      if (!s.online) console.log(`   ⚠️  Ollama not reachable at ${s.host} — AI features disabled until it is running.`);
      else if (!s.installed) console.log(`   ⚠️  Model "${s.model}" not installed. Run: ollama pull ${s.model}`);
      else console.log(`   ✦ AI ready with ${s.model}`);
    });
  });
}

module.exports = { server, start, refresh };
