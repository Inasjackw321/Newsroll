// Fast keyword-based topic tagging. Runs instantly on every story so the
// timeline can be filtered without waiting on the language model.
const TOPICS = {
  Politics: ['election', 'president', 'minister', 'parliament', 'senate', 'congress', 'vote', 'government', 'policy', 'campaign', 'democrat', 'republican', 'labour', 'conservative', 'prime minister', 'white house', 'law', 'court', 'supreme court', 'trump', 'biden'],
  World: ['war', 'ukraine', 'russia', 'gaza', 'israel', 'china', 'india', 'un', 'united nations', 'nato', 'border', 'refugee', 'military', 'troops', 'ceasefire', 'embassy', 'sanctions', 'africa', 'europe', 'asia'],
  Business: ['market', 'stocks', 'economy', 'inflation', 'bank', 'shares', 'company', 'profit', 'jobs', 'trade', 'tariff', 'interest rate', 'investor', 'ceo', 'billion', 'startup', 'merger', 'retail', 'oil price'],
  Tech: ['ai', 'artificial intelligence', 'tech', 'apple', 'google', 'microsoft', 'meta', 'software', 'app', 'chip', 'robot', 'cyber', 'hack', 'smartphone', 'internet', 'data', 'openai', 'nvidia', 'computer', 'online'],
  Science: ['science', 'space', 'nasa', 'scientists', 'research', 'study', 'planet', 'moon', 'mars', 'telescope', 'physics', 'species', 'discovery', 'fossil', 'rocket'],
  Climate: ['climate', 'weather', 'storm', 'hurricane', 'flood', 'wildfire', 'heatwave', 'emissions', 'carbon', 'drought', 'earthquake', 'environment', 'renewable', 'energy'],
  Health: ['health', 'hospital', 'covid', 'virus', 'disease', 'vaccine', 'cancer', 'doctor', 'nhs', 'medical', 'drug', 'outbreak', 'mental health', 'patients'],
  Sports: ['football', 'soccer', 'nba', 'nfl', 'cricket', 'tennis', 'olympic', 'cup', 'league', 'match', 'coach', 'championship', 'goal', 'premier league', 'f1', 'formula 1', 'golf'],
  Culture: ['film', 'movie', 'music', 'album', 'festival', 'celebrity', 'art', 'book', 'tv', 'netflix', 'actor', 'singer', 'award', 'oscar', 'museum', 'fashion', 'artefact', 'gallery', 'sculpture', 'theatre'],
};

// Short words (ai, un, f1...) must match whole words; longer ones match as a
// word prefix so "elections" counts for "election".
const MATCHERS = Object.entries(TOPICS).map(([topic, words]) => [
  topic,
  words.map((w) => {
    const word = w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(word.length <= 3 ? `\\b${word}\\b` : `\\b${word}`, 'i');
  }),
]);

function tagTopic(item) {
  const text = `${item.title} ${item.summary || ''}`;
  let best = 'General';
  let bestScore = 0;
  for (const [topic, patterns] of MATCHERS) {
    let score = 0;
    for (const re of patterns) {
      // Headline hits count double: they say what the story is really about.
      if (re.test(item.title)) score += 2;
      else if (re.test(text)) score += 1;
    }
    if (score > bestScore) {
      best = topic;
      bestScore = score;
    }
  }
  return best;
}

module.exports = { tagTopic, TOPICS: Object.keys(TOPICS) };
