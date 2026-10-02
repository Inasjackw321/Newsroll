// User settings (enabled sources, custom sources, AI model), saved as JSON.
// The desktop app stores this in the OS app-data folder via NEWSROLL_DATA.
const fs = require('fs');
const path = require('path');
const { CATALOG } = require('./catalog');

const dataDir = () => process.env.NEWSROLL_DATA || path.join(__dirname, '..', 'data');
const file = () => path.join(dataDir(), 'settings.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    cache = {};
  }
  cache.enabled ||= {};
  cache.custom ||= [];
  return cache;
}

function save() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(load(), null, 2));
}

const getModel = () => load().model || process.env.OLLAMA_MODEL || 'smollm2';

function setModel(model) {
  load().model = String(model).slice(0, 100);
  save();
}

// Every known source (built-in + added by the user) with its on/off state.
function sources() {
  const s = load();
  return [...CATALOG, ...s.custom].map((src) => ({
    ...src,
    enabled: src.id in s.enabled ? s.enabled[src.id] : src.defaultOn !== false,
  }));
}

const enabledSources = () => sources().filter((src) => src.enabled);

function setEnabled(ids, on) {
  const s = load();
  for (const id of ids) s.enabled[id] = Boolean(on);
  save();
}

function addCustom(src) {
  const s = load();
  if (sources().some((x) => x.url.toLowerCase() === src.url.toLowerCase())) {
    const existing = sources().find((x) => x.url.toLowerCase() === src.url.toLowerCase());
    setEnabled([existing.id], true);
    return { ...existing, enabled: true, existed: true };
  }
  const entry = { ...src, group: 'Added by you', custom: true, defaultOn: true };
  s.custom.push(entry);
  s.enabled[entry.id] = true;
  save();
  return { ...entry, enabled: true };
}

function removeCustom(id) {
  const s = load();
  s.custom = s.custom.filter((c) => c.id !== id);
  delete s.enabled[id];
  save();
}

// For tests.
function reset() {
  cache = null;
}

module.exports = { load, getModel, setModel, sources, enabledSources, setEnabled, addCustom, removeCustom, reset, dataDir };
