// Finds the stories that answer a question, so a small model only has to read
// a handful. Scores with BM25-style weighting (rare words like names count for
// more than common ones), understands regions/topics ("middle east" → Gaza,
// Israel, Iran…), prefers fresher stories and avoids near-duplicates.

const STOPWORDS = new Set(
  ('a an and are as at be but by for from has have he her his how i in is it its me my of on or our so that the their them ' +
    'they this to was were what whats when where which who whom why will with you your about after again all also any been ' +
    'before being can could did do does doing more most new news not now over said say says some than then there these those ' +
    'today up very we would should tell give show update updates latest recent happening happened happen going go get got ' +
    'anything something everything thing things story stories headline headlines please know let lets think like just really ' +
    'much many way well week weeks day days yesterday tonight morning evening currently current situation explain summarize ' +
    'summarise summary brief briefing catch info information details detail into out off')
    .split(' '),
);

// Light stemming so "elections"/"election", "striking"/"strike" match.
function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  return w;
}

function words(text) {
  return (String(text).toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9][a-z0-9']*/g) || [])
    .map((w) => w.replace(/'$/, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.replace(/'/g, '')));
}

const terms = (text) => words(text).map(stem);

// Regions and broad topics people ask about, mapped to the words stories use.
// `group` is the Settings → Sources group to suggest when nothing matches.
const EXPANSIONS = [
  { keys: ['middle east', 'mideast'], group: 'Middle East & Africa', terms: ['israel', 'israeli', 'gaza', 'hamas', 'hezbollah', 'iran', 'iranian', 'tehran', 'lebanon', 'syria', 'syrian', 'yemen', 'houthi', 'iraq', 'saudi', 'qatar', 'jordan', 'egypt', 'palestinian', 'west bank', 'jerusalem', 'netanyahu', 'idf'] },
  { keys: ['israel', 'gaza', 'palestine', 'palestinian'], group: 'Middle East & Africa', terms: ['israel', 'israeli', 'gaza', 'hamas', 'west bank', 'netanyahu', 'palestinian', 'idf', 'hostage'] },
  { keys: ['ukraine', 'russia'], group: 'Europe', terms: ['ukraine', 'ukrainian', 'kyiv', 'zelensky', 'russia', 'russian', 'kremlin', 'putin', 'moscow'] },
  { keys: ['europe', 'european', 'eu'], group: 'Europe', terms: ['eu', 'european', 'brussels', 'france', 'french', 'germany', 'german', 'italy', 'spain', 'poland', 'netherlands', 'macron', 'nato'] },
  { keys: ['uk', 'britain', 'british', 'england'], group: 'United Kingdom', terms: ['uk', 'britain', 'british', 'england', 'london', 'starmer', 'westminster', 'nhs', 'scotland', 'wales'] },
  { keys: ['asia', 'far east'], group: 'Asia & Pacific', terms: ['china', 'chinese', 'beijing', 'japan', 'tokyo', 'india', 'indian', 'korea', 'korean', 'taiwan', 'pakistan', 'indonesia', 'philippines', 'vietnam', 'thailand'] },
  { keys: ['china', 'chinese'], group: 'Asia & Pacific', terms: ['china', 'chinese', 'beijing', 'xi', 'taiwan', 'hong kong'] },
  { keys: ['africa', 'african'], group: 'Middle East & Africa', terms: ['nigeria', 'kenya', 'ethiopia', 'sudan', 'south africa', 'congo', 'somalia', 'sahel', 'ghana', 'uganda', 'african union'] },
  { keys: ['latin america', 'south america', 'central america'], group: 'Americas', terms: ['brazil', 'mexico', 'argentina', 'venezuela', 'colombia', 'chile', 'peru', 'cuba', 'ecuador'] },
  { keys: ['canada', 'canadian'], group: 'Americas', terms: ['canada', 'canadian', 'ottawa', 'toronto', 'carney', 'trudeau'] },
  { keys: ['us politics', 'american politics', 'washington', 'politics'], group: 'United States', topic: 'Politics', terms: ['congress', 'senate', 'house', 'white house', 'election', 'trump', 'democrat', 'republican', 'president', 'supreme court', 'governor'] },
  { keys: ['election', 'elections', 'vote', 'voting'], group: 'United States', topic: 'Politics', terms: ['election', 'vote', 'poll', 'ballot', 'candidate', 'campaign'] },
  { keys: ['economy', 'economic', 'markets', 'market', 'stocks', 'stock market', 'wall street', 'finance', 'money'], group: 'Business', topic: 'Business', terms: ['economy', 'inflation', 'market', 'stock', 'share', 'interest rate', 'fed', 'central bank', 'gdp', 'jobs', 'recession', 'tariff', 'dow', 'nasdaq', 's&p'] },
  { keys: ['crypto', 'bitcoin', 'cryptocurrency'], group: 'Business', terms: ['bitcoin', 'crypto', 'ethereum', 'coin', 'token', 'blockchain'] },
  { keys: ['tech', 'technology', 'gadgets'], group: 'Tech', topic: 'Tech', terms: ['tech', 'apple', 'google', 'microsoft', 'meta', 'amazon', 'openai', 'nvidia', 'chip', 'software', 'iphone', 'android', 'startup'] },
  { keys: ['ai', 'artificial intelligence', 'chatgpt', 'llm'], group: 'Tech', topic: 'Tech', terms: ['ai', 'artificial intelligence', 'openai', 'chatgpt', 'anthropic', 'claude', 'gemini', 'nvidia', 'model', 'chatbot'] },
  { keys: ['science', 'scientific'], group: 'Science', topic: 'Science', terms: ['science', 'scientist', 'research', 'study', 'discovery', 'researcher'] },
  { keys: ['space', 'nasa', 'spacex'], group: 'Science', topic: 'Science', terms: ['nasa', 'spacex', 'moon', 'mars', 'rocket', 'launch', 'astronaut', 'telescope', 'orbit'] },
  { keys: ['climate', 'weather', 'environment'], group: 'Climate', topic: 'Climate', terms: ['climate', 'storm', 'hurricane', 'flood', 'wildfire', 'heatwave', 'emission', 'carbon', 'drought', 'weather'] },
  { keys: ['health', 'medicine', 'medical', 'disease'], group: 'Health', topic: 'Health', terms: ['health', 'hospital', 'vaccine', 'virus', 'disease', 'cancer', 'drug', 'outbreak', 'patient', 'doctor'] },
  { keys: ['sport', 'sports'], group: 'Sports', topic: 'Sports', terms: ['nfl', 'nba', 'nhl', 'mlb', 'football', 'soccer', 'league', 'match', 'cup', 'tennis', 'f1', 'game', 'coach', 'season'] },
  { keys: ['football', 'nfl'], group: 'Sports', topic: 'Sports', terms: ['nfl', 'quarterback', 'touchdown', 'football'] },
  { keys: ['soccer', 'premier league'], group: 'Sports', topic: 'Sports', terms: ['soccer', 'premier league', 'champions league', 'goal', 'striker', 'fifa'] },
  { keys: ['movies', 'film', 'entertainment', 'celebrity', 'music', 'culture'], group: 'Culture & games', topic: 'Culture', terms: ['film', 'movie', 'box office', 'actor', 'album', 'singer', 'netflix', 'show', 'celebrity', 'music'] },
  { keys: ['gaming', 'video games', 'games'], group: 'Culture & games', terms: ['game', 'gaming', 'xbox', 'playstation', 'nintendo', 'steam', 'console'] },
];

function hasPhrase(text, phrase) {
  return new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(text);
}

// Turns a question into weighted search terms.
function queryTerms(question) {
  const q = String(question).toLowerCase();
  const weights = new Map();
  const phrases = [];
  const groups = new Set();
  const topics = new Set();
  for (const t of terms(q)) weights.set(t, 1);
  for (const exp of EXPANSIONS) {
    if (!exp.keys.some((k) => hasPhrase(q, k))) continue;
    if (exp.group) groups.add(exp.group);
    if (exp.topic) topics.add(exp.topic);
    for (const k of exp.keys) for (const t of terms(k)) weights.delete(t); // the umbrella word itself rarely appears in stories
    for (const t of exp.terms) {
      if (t.includes(' ')) phrases.push(t);
      else if (!weights.has(stem(t))) weights.set(stem(t), 0.7);
    }
  }
  return { weights, phrases, groups: [...groups], topics: [...topics] };
}

const docCache = new WeakMap();
function doc(item) {
  let d = docCache.get(item);
  if (!d) {
    const text = `${item.title} ${item.summary || ''}`.toLowerCase();
    d = { title: new Set(terms(item.title)), body: new Set(terms(item.summary || '')), text };
    docCache.set(item, d);
  }
  return d;
}

const titleKey = (t) => terms(t).sort().join(' ');

// Returns { items, matched, generic, groups } for a question.
function search(question, items, { limit = 10, perSource = 2, now = Date.now() } = {}) {
  const { weights, phrases, groups, topics } = queryTerms(question);
  const generic = weights.size === 0 && phrases.length === 0;

  const freshness = (it) => {
    const hours = (now - Date.parse(it.published)) / 3600e3;
    return 1 + 0.25 * Math.max(0, 1 - hours / 48);
  };

  let scored;
  if (generic) {
    // "What's the latest?" → newest stories.
    scored = items.map((it) => ({ it, score: freshness(it) }));
  } else {
    const N = items.length || 1;
    const df = new Map();
    for (const t of weights.keys()) {
      let n = 0;
      for (const it of items) if (doc(it).title.has(t) || doc(it).body.has(t)) n++;
      df.set(t, n);
    }
    const idf = (n) => Math.log(1 + (N - n + 0.5) / (n + 0.5));

    scored = items.map((it) => {
      const d = doc(it);
      let score = 0;
      let hits = 0;
      for (const [t, w] of weights) {
        const inTitle = d.title.has(t);
        const inBody = d.body.has(t);
        if (!inTitle && !inBody) continue;
        hits++;
        score += w * idf(df.get(t)) * (inTitle ? 2 : 1);
      }
      for (const p of phrases) {
        if (hasPhrase(d.text, p)) {
          hits++;
          score += 0.7 * 3;
        }
      }
      if (score > 0 && topics.includes(it.topic)) score += 0.5;
      // Stories matching several of the question's words beat ones matching one.
      if (hits > 1) score *= 1 + 0.15 * (hits - 1);
      return { it, score: score * (score > 0 ? freshness(it) : 0) };
    });
  }

  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  // Keep the best few, at most `perSource` per outlet, skipping repeats.
  const picked = [];
  const bySource = {};
  const seen = new Set();
  for (const { it } of ranked) {
    const key = titleKey(it.title);
    if (seen.has(key)) continue;
    if ((bySource[it.source] || 0) >= perSource) continue;
    seen.add(key);
    bySource[it.source] = (bySource[it.source] || 0) + 1;
    picked.push(it);
    if (picked.length >= limit) break;
  }

  return { items: picked, matched: picked.length > 0, generic, groups };
}

module.exports = { search, queryTerms, terms, stem, EXPANSIONS };
