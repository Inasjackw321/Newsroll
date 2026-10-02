// Prompt building and streaming for the local Ollama model.
// Small models like smollm2 do best with short, explicit instructions and a
// limited amount of context, so every prompt here is kept deliberately tight.

const settings = require('./settings');

const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const currentModel = () => settings.getModel();

// Models offered in Settings → AI. Sizes are approximate download sizes.
const RECOMMENDED = [
  { name: 'smollm2', label: 'SmolLM2', size: '1.8 GB', note: 'Default. Small and quick, but often misses details.' },
  { name: 'qwen2.5:3b', label: 'Qwen 2.5', size: '1.9 GB', note: 'Recommended. Much better answers and citations, still fast.', recommended: true },
  { name: 'smollm2:360m', label: 'SmolLM2 Mini', size: '0.7 GB', note: 'Fastest. For older or low-memory computers.' },
  { name: 'llama3.2', label: 'Llama 3.2', size: '2.0 GB', note: 'Better answers, still fast. A good upgrade.' },
  { name: 'gemma3', label: 'Gemma 3', size: '3.3 GB', note: 'Clear, well-written summaries.' },
  { name: 'phi4-mini', label: 'Phi-4 Mini', size: '2.5 GB', note: 'Strong reasoning for its size.' },
  { name: 'mistral', label: 'Mistral 7B', size: '4.1 GB', note: 'Highest quality here. Needs 8 GB+ of memory.' },
];

const withTag = (name) => (name.includes(':') ? name : `${name}:latest`);
const sameModel = (a, b) => withTag(a) === withTag(b);
const MAX_CONTEXT_STORIES = 20;

function today() {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const hours = (Date.now() - d) / 3600e3;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// The best-matching stories get more detail; the rest just a headline line.
function storyList(items, detailed = 3) {
  return items
    .map((it, i) => {
      const chars = i < detailed ? 320 : 140;
      const summary = it.summary ? `\n    ${it.summary.slice(0, chars)}${it.summary.length > chars ? '…' : ''}` : '';
      return `[${i + 1}] ${it.title} (${it.source}, ${timeLabel(it.published)})${summary}`;
    })
    .join('\n');
}

const NOT_FOUND = "I couldn't find that in your stories.";

function summaryPrompt(items, label) {
  return [
    {
      role: 'system',
      content:
        `You are a concise news editor. Today is ${today()}.\n` +
        'Write a short briefing using ONLY the numbered stories. Follow this format exactly:\n' +
        'One sentence giving the big picture.\n' +
        '- One sentence about a story [2]\n' +
        '- One sentence about another story [5]\n' +
        'Write 3 to 5 bullets, each ending with the number of its story in square brackets. ' +
        'Cover different subjects. Do not invent names, numbers or facts.',
    },
    { role: 'user', content: `Stories for ${label}:\n${storyList(items, 0)}\n\nWrite the briefing.` },
  ];
}

// history: [{ q, a }] of the last turns, so follow-up questions make sense.
function askPrompt(question, items, history = []) {
  const messages = [
    {
      role: 'system',
      content:
        `You are Newsroll, a friendly news assistant. Today is ${today()}.\n` +
        'Answer the question using ONLY the numbered news stories the user gives you.\n' +
        'Rules:\n' +
        '- Answer in 2 to 4 short, plain sentences.\n' +
        '- End each sentence with the number of the story it came from, like [2].\n' +
        '- Only state facts that are written in the stories. Never add titles, ages, dates or details yourself.\n' +
        '- If several stories are relevant, combine them.\n' +
        `- If no story answers the question, reply with exactly: ${NOT_FOUND}\n\n` +
        'Example answer:\n' +
        'Oil prices fell for a fourth day after producers said they would pump more [2]. Analysts expect prices to stay low this month [5].',
    },
  ];
  for (const turn of history.slice(-2)) {
    messages.push({ role: 'user', content: turn.q }, { role: 'assistant', content: turn.a });
  }
  messages.push({ role: 'user', content: `Stories:\n${storyList(items)}\n\nQuestion: ${question}` });
  return messages;
}

// Used when the user asks the AI to answer without news stories.
function generalPrompt(question, history = []) {
  const messages = [
    {
      role: 'system',
      content:
        `You are Newsroll, a friendly assistant. Today is ${today()}.\n` +
        'Answer briefly (1 to 3 sentences) from your general knowledge. ' +
        'If the question is about recent or ongoing events, add one short sentence saying your knowledge may be out of date.',
    },
  ];
  for (const turn of history.slice(-2)) messages.push({ role: 'user', content: turn.q }, { role: 'assistant', content: turn.a });
  messages.push({ role: 'user', content: question });
  return messages;
}

function explainPrompt(item) {
  return [
    {
      role: 'system',
      content:
        `You explain a single news story to a curious reader in plain language. Today is ${today()}.\n` +
        'Reply in exactly this format, with nothing before or after:\n' +
        'TL;DR: <one sentence>\nWhy it matters: <one or two sentences>\nWatch for: <one sentence on what might happen next>\n' +
        'Use only the information given. Do not invent names, numbers or quotes.',
    },
    {
      role: 'user',
      content: `Headline: ${item.title}\nSource: ${item.source}\nPublished: ${timeLabel(item.published)}\nDetails: ${item.summary || '(none)'}`,
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
      // Low temperature keeps small models factual; num_predict stops rambling.
      options: { temperature: 0.2, top_p: 0.9, repeat_penalty: 1.1, num_ctx: 4096, num_predict: 400 },
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
  NOT_FOUND,
  summaryPrompt,
  askPrompt,
  generalPrompt,
  explainPrompt,
  status,
  streamChat,
};
