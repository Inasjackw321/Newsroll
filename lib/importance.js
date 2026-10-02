// Flags the stories that matter most, so they stand out on the timeline.
// Signals: urgent wording in the headline, how many different outlets are
// covering the same story, and how recent it is.
const { terms } = require('./search');

const BREAKING = /\b(breaking|just in|live updates?|live:|urgent|alert)\b/i;
const SEVERE = /\b(killed|kills|dead|deaths?|death toll|dies|died|explosions?|blasts?|attacks?|strikes?|airstrikes?|missiles?|drones?|bomb(ing|s)?|shooting|gunman|hostages?|earthquake|quake|tsunami|hurricane|typhoon|cyclone|wildfires?|floods?|evacuat\w*|emergency|crash(es|ed)?|war|invasion|invades?|coup|resigns?|resignation|assassinat\w*|outbreak|pandemic|martial law|collapse[ds]?|sanctions|ceasefire|impeach\w*|indicted|arrested)\b/i;

function titleTerms(item) {
  return new Set(terms(item.title).filter((t) => t.length > 2));
}

function jaccard(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

// Adds `coverage` (number of outlets on the same story) and `importance`
// (0 = normal, 1 = important, 2 = major) to every item. `dupes` maps item id
// to the number of identical headlines merged into it.
function rankImportance(items, dupes = new Map(), now = Date.now()) {
  const sets = items.map(titleTerms);
  // Index terms → items, so we only compare headlines that share words.
  const index = new Map();
  sets.forEach((set, i) => {
    for (const t of set) {
      if (!index.has(t)) index.set(t, []);
      index.get(t).push(i);
    }
  });

  // Group headlines about the same story (union-find), then count the
  // distinct outlets in each group.
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const direct = items.map((it) => new Set([it.source]));
  sets.forEach((set, i) => {
    const candidates = new Map();
    for (const t of set) {
      const list = index.get(t);
      if (list.length > 60) continue; // very common word: not informative
      for (const j of list) if (j > i) candidates.set(j, (candidates.get(j) || 0) + 1);
    }
    for (const [j, shared] of candidates) {
      if (shared >= 2 && jaccard(set, sets[j]) >= 0.3) {
        parent[find(j)] = find(i);
        direct[i].add(items[j].source);
        direct[j].add(items[i].source);
      }
    }
  });
  const clusterOutlets = new Map();
  const clusterSize = new Map();
  items.forEach((it, i) => {
    const root = find(i);
    if (!clusterOutlets.has(root)) clusterOutlets.set(root, new Set());
    clusterOutlets.get(root).add(it.source);
    clusterSize.set(root, (clusterSize.get(root) || 0) + 1);
  });
  // A huge group probably chained unrelated headlines together, so fall back
  // to direct matches only.
  const outlets = items.map((_, i) => (clusterSize.get(find(i)) > 15 ? direct[i] : clusterOutlets.get(find(i))));

  return items.map((it, i) => {
    const coverage = outlets[i].size + (dupes.get(it.id) || 0);
    const hoursOld = (now - Date.parse(it.published)) / 3600e3;
    let score = 0;
    const reasons = [];
    if (BREAKING.test(it.title)) {
      score += 2;
      reasons.push('breaking');
    }
    if (SEVERE.test(it.title)) {
      score += 1;
      reasons.push('serious');
    }
    if (coverage >= 3) score += 1;
    if (coverage >= 5) score += 1;
    if (coverage >= 3) reasons.push(`${coverage} outlets`);
    if (hoursOld < 6 && score >= 2) score += 0.5;

    const importance = score >= 3 ? 2 : score >= 2 ? 1 : 0;
    const breaking = importance > 0 && hoursOld < 2 && (reasons.includes('breaking') || coverage >= 3);
    return { ...it, coverage, importance, breaking };
  });
}

module.exports = { rankImportance };
