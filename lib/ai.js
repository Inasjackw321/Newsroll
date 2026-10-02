// Prompt building and streaming for the local Ollama model.
// Small models like smollm2 do best with short, explicit instructions and a
// limited amount of context, so every prompt here is kept deliberately tight.

const settings = require('./settings');

const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const currentModel = () => settings.getModel();

// Models offered in Settings → AI. Sizes are approximate download sizes.
const RECOMMENDED = [
  { name: 'smollm2', label: 'SmolLM2', size: '1.8 GB', note: 'Default. Small and quick, fine for summaries.' },
  { name: 'smollm2:360m', label: 'SmolLM2 Mini', size: '0.7 GB', note: 'Fastest. For older or low-memory computers.' },
  { name: 'llama3.2', label: 'Llama 3.2', size: '2.0 GB', note: 'Better answers, still fast. A good upgrade.' },
  { name: 'gemma3', label: 'Gemma 3', size: '3.3 GB', note: 'Clear, well-written summaries.' },
  { name: 'qwen2.5:3b', label: 'Qwen 2.5', size: '1.9 GB', note: 'Good at following instructions and citing stories.' },
  { name: 'phi4-mini', label: 'Phi-4 Mini', size: '2.5 GB', note: 'Strong reasoning for its size.' },
  { name: 'mistral', label: 'Mistral 7B', size: '4.1 GB', note: 'Highest quality here. Needs 8 GB+ of memory.' },
];

const withTag = (name) => (name.includes(':') ? name : `${name}:latest`);
const sameModel = (a, b) => withTag(a) === withTag(b);
const MAX_CONTEXT_STORIES = 20;

const STOPWORDS = new Set(
  ('a an and are as at be but by for from has have he her his how in is it its of on or that the their them they this to ' +
    'was were what when where which who why will with you your about after again all also any been before being can could ' +
    'did do does more most new news not now over said says so some than then there these those today up very we would')
    .split(' '),
);

function tokens(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Lightweight retrieval: score stories by keyword overlap with the question so
// the model only sees the handful of stories that are actually relevant.
function rankByRelevance(question, items, limit = 8) {
  const q = new Set(tokens(question));
  if (!q.size) return items.slice(0, limit);
  const scored = items.map((item, i) => {
    const words = tokens(`${item.title} ${item.title} ${item.summary}`);
    let score = 0;
    for (const w of words) if (q.has(w)) score++;
    if (q.has((item.topic || '').toLowerCase())) score += 2;
    // Slight recency bias as a tie breaker (items arrive newest first).
    return { item, score: score + (items.length - i) / (items.length * 10) };
  });
  const hits = scored.filter((s) => s.score >= 1).sort((a, b) => b.score - a.score);
  // Nothing matched? Fall back to the latest headlines so "what happened?" still works.
  return (hits.length ? hits : scored).slice(0, limit).map((s) => s.item);
}

function timeLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function storyList(items, summaryChars = 160) {
  return items
    .map((it, i) => {
      const summary = it.summary ? ` — ${it.summary.slice(0, summaryChars)}` : '';
      return `[${i + 1}] (${it.source}, ${timeLabel(it.published)}) ${it.title}${summary}`;
    })
    .join('\n');
}

function summaryPrompt(items, label) {
  return [
    {
      role: 'system',
      content:
        'You are a concise news editor. Write a short news briefing using ONLY the numbered stories given. ' +
        'Start with one sentence giving the big picture. Then write 3 to 5 bullet points starting with "- ", one sentence each. ' +
        'End every bullet with the story numbers it uses in square brackets, like [2] or [1][4]. Do not invent facts.',
    },
    { role: 'user', content: `Stories for ${label}:\n${storyList(items)}\n\nWrite the briefing.` },
  ];
}

function askPrompt(question, items) {
  return [
    {
      role: 'system',
      content:
        'You answer questions about the news using ONLY the numbered stories given. ' +
        'Answer in 2 to 4 short sentences. Cite the story numbers you used in square brackets, like [3]. ' +
        'If the stories do not contain the answer, say "The current headlines don\'t cover that." and nothing else.',
    },
    { role: 'user', content: `Stories:\n${storyList(items, 240)}\n\nQuestion: ${question}` },
  ];
}

function explainPrompt(item) {
  return [
    {
      role: 'system',
      content:
        'You explain a single news story to a curious reader in plain language. Reply in exactly this format:\n' +
        'TL;DR: <one sentence>\nWhy it matters: <one or two sentences>\nWatch for: <one sentence on what might happen next>\n' +
        'Use only the information given. Keep it short.',
    },
    {
      role: 'user',
      content: `Headline: ${item.title}\nSource: ${item.source}\nTopic: ${item.topic}\nDetails: ${item.summary || '(none)'}`,
    },
  ];
}

async function status() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models = [] } = await res.json();
    const names = models.map((m) => m.name);
    const model = currentModel();
    const installed = names.some((n) => sameModel(n, model));
    const list = models.map((m) => ({ name: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size }));
    return { online: true, installed, model, host: OLLAMA_HOST, models: list, recommended: RECOMMENDED };
  } catch (err) {
    return { online: false, installed: false, model: currentModel(), host: OLLAMA_HOST, models: [], recommended: RECOMMENDED, error: err.message };
  }
}

// Streams plain-text tokens from Ollama's /api/chat into `onToken`.
async function streamChat(messages, onToken, signal) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: currentModel(),
      messages,
      stream: true,
      options: { temperature: 0.3, num_ctx: 4096 },
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      if (data.message?.content) onToken(data.message.content);
    }
  }
}

// Downloads a model through Ollama, calling onProgress({ status, completed, total }).
async function pullModel(name, onProgress, signal) {
  const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      onProgress(data);
    }
  }
}

module.exports = {
  RECOMMENDED,
  pullModel,
  sameModel,
  MAX_CONTEXT_STORIES,
  rankByRelevance,
  summaryPrompt,
  askPrompt,
  explainPrompt,
  status,
  streamChat,
  tokens,
};
