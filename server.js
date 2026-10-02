// Newsroll: a tiny news timeline server (RSS + Telegram) with local AI via Ollama.
// No runtime dependencies — just Node 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseFeed } = require('./lib/rss');
const { parseTelegram, channelName, previewUrl } = require('./lib/telegram');
const { tagTopic } = require('./lib/topics');
const { sampleItems } = require('./lib/sample');
const { GROUP_ORDER, slug } = require('./lib/catalog');
const settings = require('./lib/settings');
const ai = require('./lib/ai');
const { search } = require('./lib/search');
const intent = require('./lib/intent');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 2 * 24 * 3600 * 1000;
const MAX_ITEMS = 800;
const CONCURRENCY = 12;
const UA = 'Mozilla/5.0 (compatible; Newsroll/0.2; +https://github.com/Inasjackw321/Newsroll)';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

let cache = { items: [], fetchedAt: 0, sample: false, sources: 0, failed: [] };
let inflight = null;
const status = new Map(); // source id -> { ok, count, error, checkedAt }
const lastGood = new Map(); // source id -> items from the last successful fetch

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8' },
    signal: AbortSignal.timeout(10000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchSource(src) {
  const items = src.type === 'telegram'
    ? parseTelegram(await get(previewUrl(src.url)), src.url)
    : parseFeed(await get(src.url), src.name);
  return items.map((it) => ({ ...it, source: src.name || it.source, sourceId: src.id, type: src.type }));
}

// Runs fn over items with at most `limit` in flight.
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try {
        out[i] = { ok: true, value: await fn(list[i]) };
      } catch (err) {
        out[i] = { ok: false, error: err.cause?.code || err.cause?.message || err.message || String(err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

const titleKey = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function refresh() {
  const srcs = settings.enabledSources();
  const results = await mapLimit(srcs, CONCURRENCY, fetchSource);
  const now = Date.now();

  results.forEach((r, i) => {
    const src = srcs[i];
    if (r.ok) {
      lastGood.set(src.id, r.value);
      status.set(src.id, { ok: true, count: r.value.length, checkedAt: now });
    } else {
      status.set(src.id, { ok: false, error: r.error, count: lastGood.get(src.id)?.length || 0, checkedAt: now });
    }
  });

  // Merge, dropping exact duplicates and the same headline from several feeds.
  const seenIds = new Set();
  const seenTitles = new Set();
  let items = [];
  for (const src of srcs) {
    for (const item of lastGood.get(src.id) || []) {
      const key = titleKey(item.title);
      if (seenIds.has(item.id) || seenTitles.has(key)) continue;
      seenIds.add(item.id);
      seenTitles.add(key);
      items.push(item);
    }
  }

  const sample = items.length === 0 && srcs.length > 0;
  if (sample) items = sampleItems();

  items = items
    .map((it) => ({ ...it, published: it.published || new Date(now).toISOString(), topic: tagTopic(it) }))
    .filter((it) => now - Date.parse(it.published) < MAX_AGE_MS && Date.parse(it.published) <= now + 3600e3)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, MAX_ITEMS);

  const failed = srcs.filter((s) => status.get(s.id)?.ok === false).map((s) => s.name);
  cache = { items, fetchedAt: now, sample, sources: srcs.length, failed };
  return cache;
}

async function getItems(force = false) {
  if (!force && cache.fetchedAt && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  if (!inflight) inflight = refresh().finally(() => (inflight = null));
  return inflight;
}

function sourcesWithStatus() {
  return settings.sources().map((s) => ({ ...s, status: status.get(s.id) || null }));
}

// Finds the RSS/Atom feed a web page advertises, e.g. for "https://example.com".
function discoverFeed(html, base) {
  const link = html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i)?.[0];
  const href = link?.match(/href=["']([^"']+)["']/i)?.[1];
  return href ? new URL(href.replace(/&amp;/g, '&'), base).toString() : null;
}

// Works out what the user pasted: a Telegram channel, a feed, or a website.
async function resolveSource(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste a website, RSS link or Telegram channel.');

  if (/t\.me\/|telegram\.me\/|^@/.test(raw) || (!/[./]/.test(raw) && channelName(raw))) {
    const name = channelName(raw);
    if (!name) throw new Error("That doesn't look like a Telegram channel name.");
    const src = { id: `tg-${name.toLowerCase()}`, name: `@${name}`, url: name, type: 'telegram' };
    try {
      const items = parseTelegram(await get(previewUrl(name)), name);
      if (items[0]) src.name = items[0].source;
      return { src, warning: items.length ? null : 'No public posts found. Is the channel public?' };
    } catch (err) {
      return { src, warning: `Couldn't reach Telegram right now (${err.message}). It will keep trying.` };
    }
  }

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).toString();
  } catch {
    throw new Error("That doesn't look like a web address.");
  }
  const src = { id: `custom-${slug(url).slice(0, 60)}`, name: new URL(url).hostname.replace(/^www\./, ''), url, type: 'rss' };
  try {
    const body = await get(url);
    let items = parseFeed(body);
    if (!items.length) {
      const feed = discoverFeed(body, url);
      if (!feed) return { src, warning: "That page doesn't seem to have a news feed. Try its RSS link instead." };
      src.url = feed;
      src.id = `custom-${slug(feed).slice(0, 60)}`;
      items = parseFeed(await get(feed));
    }
    if (items[0]?.source && items[0].source !== 'Unknown') src.name = items[0].source;
    return { src, warning: items.length ? null : 'The feed loaded but has no stories yet.' };
  } catch (err) {
    return { src, warning: `Couldn't load it right now (${err.message}). It will keep trying.` };
  }
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
function aiHeaders(sources, mode, groups = []) {
  return {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Newsroll-Sources': sources.map((s) => s.id).join(','),
    'X-Newsroll-Mode': mode,
    'X-Newsroll-Groups': encodeURIComponent(groups.join('|')),
  };
}

// A reply that doesn't need the model (maths, greetings, "not found").
function sendText(res, text, mode, groups) {
  res.writeHead(200, aiHeaders([], mode, groups));
  res.end(text);
}

async function streamAi(req, res, messages, sources = [], mode = 'answer') {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.writeHead(200, aiHeaders(sources, mode));
  try {
    await ai.streamChat(messages, (token) => res.write(token), controller.signal);
  } catch (err) {
    if (!controller.signal.aborted) {
      const hint = /fetch failed|ECONNREFUSED/i.test(err.message + (err.cause?.message || ''))
        ? `The AI isn't running. Open Settings → AI to set it up.`
        : err.message;
      res.write(`\n\n⚠️ ${hint}`);
    }
  }
  res.end();
}

// Up to `limit` stories, at most two per source, so one busy feed can't
// dominate a summary.
function diverse(items, limit) {
  const perSource = {};
  const first = items.filter((it) => (perSource[it.source] = (perSource[it.source] || 0) + 1) <= 2);
  const rest = items.filter((it) => !first.includes(it));
  return [...first, ...rest].slice(0, limit);
}

function pickItems(items, ids) {
  if (!Array.isArray(ids) || !ids.length) return items;
  const wanted = new Set(ids);
  return items.filter((it) => wanted.has(it.id));
}

const HELP_TEXT = [
  "I'm Newsroll's assistant. I read the stories in your timeline and answer questions about them.",
  '- Ask things like "What\'s happening in the Middle East?" or "Any news about Apple?"',
  '- Follow up with "why?" or "tell me more"',
  '- Tap the numbers in my answers to jump to the story',
  'You can also tap ✦ Summarize for a quick briefing, or ✦ Explain on any story.',
].join('\n');

// "what happened with Mike Tomlin?" → "Mike Tomlin"
function subjectOf(question) {
  const subject = question
    .replace(/[?.!]+$/, '')
    .replace(/^(please\s+)?(can you\s+)?(tell me|give me|show me|update me|catch me up)?\s*(what('s| is| has| happened| is happening| is going on)|what's going on|how('s| is)|is there|are there|any)?\s*(the\s+)?(latest|news|an update|updates?|new|happening|going on|happened|anything|something)?\s*(about|on|with|to|in|regarding|for)?\s+/i, '')
    .replace(/^the\s+/i, '')
    .trim();
  return subject || question.replace(/[?.!]+$/, '');
}

async function answerQuestion(res, question, items, history, general) {
  const kind = intent.classify(question);
  if (kind === 'math') {
    const value = intent.evalMath(question);
    return sendText(res, `${question.replace(/[=?]\s*$/, '').trim()} = ${intent.formatNumber(value)}`, 'direct');
  }
  if (kind === 'greeting') {
    const topic = items.find((it) => it.topic && it.topic !== 'General')?.topic;
    const example = topic ? `What's happening in ${topic.toLowerCase()}?` : 'What happened today?';
    return sendText(res, `Hi! Ask me anything about today's news, like “${example}”`, 'direct');
  }
  if (kind === 'help') return sendText(res, HELP_TEXT, 'direct');
  if (general) return streamAi(null, res, ai.generalPrompt(question, history), [], 'general');

  // Follow-ups ("why?", "tell me more") search using the previous question too.
  const query = history.length && intent.isFollowUp(question) ? `${history[history.length - 1].q} ${question}` : question;
  const found = search(query, items, { limit: 8 });
  if (!found.matched) {
    return sendText(res, `I couldn't find anything about “${subjectOf(question)}” in your ${items.length} stories.`, 'notfound', found.groups);
  }
  return streamAi(null, res, ai.askPrompt(question, found.items, history), found.items, 'answer');
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/feed') {
    const data = await getItems(url.searchParams.has('force'));
    return sendJson(res, 200, data);
  }

  if (req.method === 'GET' && url.pathname === '/api/ai/status') {
    return sendJson(res, 200, await ai.status());
  }

  // ---- Sources ----
  if (url.pathname === '/api/sources') {
    if (req.method === 'GET') return sendJson(res, 200, { groups: GROUP_ORDER, sources: sourcesWithStatus() });
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { src, warning } = await resolveSource(body.input);
        const added = settings.addCustom(src);
        cache.fetchedAt = 0;
        return sendJson(res, 200, { source: added, warning });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      settings.setEnabled(ids, body.enabled);
      cache.fetchedAt = 0; // pick up the change on the next load
      return sendJson(res, 200, { ok: true });
    }
  }
  const del = url.pathname.match(/^\/api\/sources\/([\w-]+)$/);
  if (del && req.method === 'DELETE') {
    settings.removeCustom(del[1]);
    cache.fetchedAt = 0;
    return sendJson(res, 200, { ok: true });
  }

  // ---- AI model ----
  if (req.method === 'PUT' && url.pathname === '/api/ai/model') {
    const body = await readBody(req);
    if (!body.model) return sendJson(res, 400, { error: 'model is required' });
    settings.setModel(body.model);
    return sendJson(res, 200, await ai.status());
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/pull') {
    const body = await readBody(req);
    const model = String(body.model || '').trim();
    if (!/^[\w.:/-]{1,100}$/.test(model)) return sendJson(res, 400, { error: 'Invalid model name' });
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    try {
      await ai.pullModel(model, (p) => res.write(JSON.stringify({ status: p.status, completed: p.completed, total: p.total }) + '\n'), controller.signal);
      res.write(JSON.stringify({ status: 'success', done: true }) + '\n');
    } catch (err) {
      if (!controller.signal.aborted) res.write(JSON.stringify({ error: /fetch failed|ECONNREFUSED/i.test(err.message) ? "The AI engine (Ollama) isn't running." : err.message }) + '\n');
    }
    return res.end();
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/ai/')) {
    const body = await readBody(req);
    const { items } = await getItems();
    const action = url.pathname.slice('/api/ai/'.length);

    if (action === 'summary') {
      const chosen = diverse(pickItems(items, body.ids), ai.MAX_CONTEXT_STORIES);
      if (!chosen.length) return sendJson(res, 400, { error: 'No stories to summarise' });
      return streamAi(req, res, ai.summaryPrompt(chosen, String(body.label || 'today').slice(0, 60)), chosen);
    }

    if (action === 'ask') {
      const question = String(body.question || '').trim().slice(0, 500);
      if (!question) return sendJson(res, 400, { error: 'Question is required' });
      const history = (Array.isArray(body.history) ? body.history : [])
        .slice(-2)
        .map((t) => ({ q: String(t.q || '').slice(0, 300), a: String(t.a || '').slice(0, 600) }))
        .filter((t) => t.q && t.a);
      return answerQuestion(res, question, pickItems(items, body.ids), history, Boolean(body.general));
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
