// Newsroll front-end: a simple news timeline with local AI (Ollama) features.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const REFRESH_MS = 5 * 60 * 1000;
  const VISIT_KEY = 'newsroll:lastVisit';
  const TOPIC_KEY = 'newsroll:topic';

  const state = {
    items: [],
    byId: new Map(),
    topic: storage(TOPIC_KEY) || 'all',
    // The previous visit is captured once so "new" markers survive refreshes.
    prevVisit: Number(storage(VISIT_KEY)) || 0,
    pending: null,
    ai: null,
    query: '',
  };

  function storage(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch {
      return null;
    }
  }

  // ---------- Helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ts = (it) => Date.parse(it.published);
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  function dayLabel(t) {
    const today = startOfDay(Date.now());
    const day = startOfDay(t);
    if (day === today) return 'Today';
    if (day === today - 864e5) return 'Yesterday';
    return new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function relTime(t) {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 6 * 60) return `${Math.floor(mins / 60)}h ago`;
    return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  const STOP = new Set('the a an and or of to in on for with at by from as is are was were be been has have had it its this that these those after over into amid says said new will can could would than more most about up out not but who what when how why first last says year years week day days'.split(' '));
  const tokenCache = new Map();
  function tokensOf(it) {
    if (!tokenCache.has(it.id)) {
      const words = `${it.title} ${it.summary}`.toLowerCase().match(/[a-z][a-z0-9'-]+/g) || [];
      tokenCache.set(it.id, new Set(words.filter((w) => w.length > 3 && !STOP.has(w))));
    }
    return tokenCache.get(it.id);
  }

  // Related stories via keyword overlap (cosine on word sets) — instant, no model needed.
  function related(item, n = 3) {
    const a = tokensOf(item);
    if (!a.size) return [];
    return state.items
      .filter((o) => o.id !== item.id)
      .map((o) => {
        const b = tokensOf(o);
        let shared = 0;
        for (const w of a) if (b.has(w)) shared++;
        return { o, shared, score: shared / Math.sqrt(a.size * (b.size || 1)) };
      })
      .filter((r) => r.shared >= 2 && r.score >= 0.16)
      .sort((x, y) => y.score - x.score)
      .slice(0, n)
      .map((r) => r.o);
  }

  function visibleItems() {
    let list = state.items;
    if (state.variable) {
      const v = state.variables.find((x) => x.id === state.variable);
      if (v) {
        const compiled = compileVariable(v);
        list = list.filter((it) => matchesVariable(compiled, it));
      }
    }
    if (state.topic === 'Important') list = list.filter((it) => it.importance > 0);
    else if (state.topic === 'Telegram') list = list.filter((it) => it.type === 'telegram');
    else if (state.topic !== 'all') list = list.filter((it) => it.topic === state.topic);
    const q = state.query.trim().toLowerCase();
    if (q) list = list.filter((it) => `${it.title} ${it.summary} ${it.source}`.toLowerCase().includes(q));
    return list;
  }

  const aiReady = () => Boolean(state.ai?.online && state.ai?.installed);

  // ---------- Feed loading ----------
  async function loadFeed({ force = false, initial = false } = {}) {
    const btn = $('#refreshBtn');
    btn.classList.add('spinning');
    try {
      const res = await fetch(`/api/feed${force ? '?force=1' : ''}`);
      const data = await res.json();
      if (initial || !state.items.length) {
        setItems(data.items);
        render();
      } else {
        const known = new Set(state.items.map((i) => i.id));
        const fresh = data.items.filter((i) => !known.has(i.id));
        if (fresh.length) {
          state.pending = data.items;
          if (window.scrollY < 200 || force) applyPending();
          else showNewPill(fresh.length);
        }
      }
      updateFooter(data);
    } catch (err) {
      if (!state.items.length) $('#timelineBody').innerHTML = `<div class="empty">Couldn't load the news. ${esc(err.message)}</div>`;
    } finally {
      btn.classList.remove('spinning');
    }
  }

  function setItems(items) {
    state.items = items;
    state.byId = new Map(items.map((i) => [i.id, i]));
  }

  function applyPending() {
    if (!state.pending) return;
    setItems(state.pending);
    state.pending = null;
    $('#newPill').classList.add('hidden');
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showNewPill(n) {
    const pill = $('#newPill');
    $('span', pill).textContent = plural(n, 'new story', 'new stories');
    pill.classList.remove('hidden');
  }

  function updateFooter(data) {
    const time = new Date(data.fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const foot = $('#footNote');
    if (!data.sources) {
      foot.innerHTML = `No sources are switched on. <button class="link-btn" data-open-settings="sources">Choose sources</button>`;
      return;
    }
    const failed = data.failed?.length ? ` · ${data.failed.length} couldn't load` : '';
    foot.innerHTML = data.sample
      ? `Couldn't reach your news sources, so these are sample stories. <button class="link-btn" data-open-settings="sources">Check sources</button>`
      : `${plural(data.items.length, 'story', 'stories')} from ${plural(data.sources, 'source')}${failed} · Updated ${time} · <button class="link-btn" data-open-settings="sources">Manage sources</button>`;
  }

  function renderMasthead() {
    const h = new Date().getHours();
    $('#greeting').textContent = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    $('#dateLine').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // ---------- Rendering ----------
  const revealer = new IntersectionObserver(
    (entries) => {
      let i = 0;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.style.setProperty('--d', `${Math.min(i++, 8) * 40}ms`);
        e.target.classList.add('in');
        revealer.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -30px 0px' },
  );

  function renderFilters() {
    const counts = {};
    for (const it of state.items) counts[it.topic] = (counts[it.topic] || 0) + 1;
    const topics = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const hasTelegram = state.items.some((it) => it.type === 'telegram');
    const important = state.items.filter((it) => it.importance > 0).length;
    const special = { Telegram: hasTelegram, Important: important > 0 };
    if (state.topic !== 'all' && !counts[state.topic] && !special[state.topic]) state.topic = 'all';
    $('#filters').innerHTML = ['all', ...(important ? ['Important'] : []), ...(hasTelegram ? ['Telegram'] : []), ...topics]
      .map((t) => `<button class="filter${state.topic === t ? ' active' : ''}${t === 'Important' ? ' imp-filter' : ''}" data-topic="${esc(t)}">${t === 'all' ? 'All' : t === 'Important' ? `<span class="imp-dot"></span>Important <span class="n">${important}</span>` : esc(t)}</button>`)
      .join('');
  }

  function importanceBadge(it) {
    if (it.breaking) return '<span class="imp breaking">Breaking</span> ';
    if (it.importance === 2) return '<span class="imp major">Major</span> ';
    if (it.importance === 1) return '<span class="imp">Important</span> ';
    return '';
  }

  function itemHtml(it) {
    const t = ts(it);
    const fresh = state.prevVisit && t > state.prevVisit;
    return `
      <article class="tl-item${fresh ? ' fresh' : ''}${it.importance ? ` imp-${it.importance}` : ''}${it.breaking ? ' breaking' : ''}" data-id="${it.id}" tabindex="-1">
        <span class="tl-dot"></span>
        <div class="tl-card" role="button" tabindex="0" aria-expanded="false">
          <div class="tl-meta">${importanceBadge(it)}<time datetime="${esc(it.published)}">${relTime(t)}</time> · ${esc(it.source)}${it.type === 'telegram' ? ' <span class="tg">Telegram</span>' : ''}${it.coverage >= 2 ? ` · <span title="Reported by ${it.coverage} outlets">${it.coverage} outlets</span>` : ''}${fresh ? ' · <b>New</b>' : ''}</div>
          <h3 class="tl-title">${esc(it.title)}</h3>
          <div class="tl-more"><div><div class="tl-more-inner"></div></div></div>
        </div>
      </article>`;
  }

  function render() {
    renderFilters();
    renderSuggestions();
    updateSummaryButton();
    renderVariables();
    const list = visibleItems();
    renderVarFilter(list.length);
    const body = $('#timelineBody');
    if (!list.length) {
      body.innerHTML = state.query
        ? `<div class="empty">No stories match “${esc(state.query)}”.</div>`
        : '<div class="empty">No stories here yet.</div>';
      return;
    }

    let html = '';
    let curDay = null;
    for (const it of list) {
      const day = startOfDay(ts(it));
      if (day !== curDay) {
        curDay = day;
        html += `
          <div class="day" data-day="${day}">
            <h2>${esc(dayLabel(day))}</h2>
            <button class="day-sum" title="Summarize ${esc(dayLabel(day).toLowerCase())}" aria-label="Summarize ${esc(dayLabel(day).toLowerCase())}"><span class="spark">✦</span> Summary</button>
          </div>
          <div class="day-summary hidden" data-day-summary="${day}"><div class="ai-output"></div></div>`;
      }
      html += itemHtml(it);
    }
    body.innerHTML = html;
    $$('.tl-item', body).forEach((el) => revealer.observe(el));
    onScroll();
  }

  function renderSuggestions() {
    const list = visibleItems();
    const counts = {};
    for (const it of state.items) if (it.topic !== 'General') counts[it.topic] = (counts[it.topic] || 0) + 1;
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 2);

    // A capitalised name that recurs across headlines (e.g. "Gaza", "Apple")
    // makes a good "trending" question.
    const freq = {};
    for (const it of list) {
      const names = new Set((it.title.match(/(?<=\S\s)[A-Z][a-z]{3,}/g) || []).filter((w) => !STOP.has(w.toLowerCase())));
      for (const w of names) freq[w] = (freq[w] || 0) + 1;
    }
    const trending = Object.entries(freq).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])[0]?.[0];

    const qs = [];
    if (trending) qs.push(`What's the latest on ${trending}?`);
    if (state.topic !== 'all') qs.push(`What are the big ${state.topic.toLowerCase()} stories?`);
    else top.forEach((t) => qs.push(`What's happening in ${t.toLowerCase()}?`));
    qs.push('What happened overnight?');
    $('#suggestions').innerHTML = qs.slice(0, 3).map((q) => `<button class="chip" type="button">${esc(q)}</button>`).join('');
  }

  // ---------- Expand / collapse ----------
  function toggleItem(el, open = !el.classList.contains('open')) {
    const it = state.byId.get(el.dataset.id);
    if (!it) return;
    const inner = $('.tl-more-inner', el);
    if (open && !inner.dataset.ready) {
      const rel = related(it);
      inner.innerHTML = `
        ${it.image ? `<img class="tl-img" alt="" loading="lazy" referrerpolicy="no-referrer" src="${esc(it.image)}" onload="this.classList.add('loaded')" onerror="this.remove()">` : ''}
        ${it.summary ? `<p class="tl-summary">${esc(it.summary)}</p>` : ''}
        <div class="tl-actions">
          <button class="pill-btn ai explain-btn"><span class="spark">✦</span> Explain</button>
          ${it.link ? `<a class="pill-btn" href="${esc(it.link)}" target="_blank" rel="noopener">Open story ↗</a>` : ''}
        </div>
        <div class="tl-explain"></div>
        ${rel.length ? `<div class="related"><h4>Related</h4>${rel.map((r) => `<button data-jump="${r.id}">${esc(r.title)}</button>`).join('')}</div>` : ''}`;
      inner.dataset.ready = '1';
    }
    el.classList.toggle('open', open);
    $('.tl-card', el).setAttribute('aria-expanded', String(open));
  }

  function jumpTo(id) {
    const it = state.byId.get(id);
    if (!it) {
      // An older story from a saved chat that's no longer on the timeline.
      const known = knownStories.get(id);
      if (known?.link) window.open(known.link, '_blank', 'noopener');
      return;
    }
    if (state.variable) setVariableFilter(null);
    closeSheet();
    if (state.topic !== 'all' && it.topic !== state.topic) setTopic('all');
    const el = $(`.tl-item[data-id="${id}"]`);
    if (!el) return;
    el.classList.add('in');
    toggleItem(el, true);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
    el.focus({ preventScroll: true });
  }

  function setTopic(topic) {
    state.topic = topic;
    storage(TOPIC_KEY, topic);
    $('#summaryBox').classList.add('hidden');
    render();
  }

  // ---------- AI output rendering ----------
  const LABELS = /^(TL;DR|Why it matters|Watch for|Big picture|Summary)\s*:/i;

  function inline(text, sources) {
    return esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\s*\[(\d+(?:\s*[,&]\s*\d+)*)\]/g, (m, nums) =>
        nums
          .split(/[,&]/)
          .map((n) => {
            const src = sources[Number(n.trim()) - 1];
            return src ? `<button class="cite" data-jump="${src.id}" title="${esc(src.title)}">${Number(n)}</button>` : '';
          })
          .join(''),
      );
  }

  // Renders model output as flat blocks (paragraphs / bullets) and patches the
  // DOM in place, so while tokens stream only new lines animate in.
  function renderAi(el, text, sources) {
    const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    const blocks = lines.map((line) => {
      const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (bullet) return { cls: 'bullet', html: inline(bullet[1], sources) };
      if (line.startsWith('⚠️')) return { cls: 'warn', html: esc(line.replace(/^⚠️\s*/, '')) };
      const label = line.match(LABELS);
      if (label) return { cls: '', html: `<span class="label">${esc(label[0])}</span>${inline(line.slice(label[0].length), sources)}` };
      return { cls: '', html: inline(line.replace(/^#+\s*/, ''), sources) };
    });
    if (!blocks.length) blocks.push({ cls: '', html: '' });

    const kids = el.children;
    if (kids[0] && kids[0].tagName !== 'P') el.innerHTML = ''; // drop the "thinking" dots
    blocks.forEach((b, i) => {
      let p = kids[i];
      if (!p) {
        p = document.createElement('p');
        el.append(p);
      }
      if (p.className !== b.cls) p.className = b.cls;
      if (p.innerHTML !== b.html) p.innerHTML = b.html;
    });
    while (kids.length > blocks.length) el.lastElementChild.remove();
  }

  const streams = new WeakMap();
  let activeStreams = 0;

  // POSTs to an AI endpoint and streams the model's reply into `el`.
  // Resolves with { text, sources, mode, groups }, or null if it failed.
  async function streamInto(el, endpoint, payload, button) {
    let result = null;
    streams.get(el)?.abort();
    const controller = new AbortController();
    streams.set(el, controller);
    el.classList.add('streaming');
    el.innerHTML = '<div class="thinking"><i></i><i></i><i></i></div>';
    if (button) button.disabled = true;
    setBusy(+1);

    try {
      const res = await fetch(`/api/ai/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Request failed (${res.status})`);
      }
      const sources = (res.headers.get('X-Newsroll-Sources') || '').split(',').map((id) => state.byId.get(id)).filter(Boolean);
      const mode = res.headers.get('X-Newsroll-Mode') || 'answer';
      const groups = decodeURIComponent(res.headers.get('X-Newsroll-Groups') || '').split('|').filter(Boolean);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let queued = false;
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (!queued) {
          queued = true;
          requestAnimationFrame(() => {
            queued = false;
            if (!finished) renderAi(el, text, sources);
          });
        }
      }
      finished = true;
      text = text.trim() || '⚠️ The model returned an empty reply. Try again.';
      renderAi(el, text, sources);
      result = { text, sources, mode, groups };
    } catch (err) {
      if (err.name !== 'AbortError') el.innerHTML = `<p class="warn">${esc(err.message)}</p>`;
    } finally {
      if (streams.get(el) === controller) {
        el.classList.remove('streaming');
        streams.delete(el);
      }
      if (button) button.disabled = false;
      setBusy(-1);
    }
    return result;
  }

  function setBusy(delta) {
    activeStreams += delta;
    // The dot in the "N." logo lights up while the AI is working.
    document.body.classList.toggle('ai-busy', activeStreams > 0);
  }

  // ---------- Summary (one smart button) ----------
  // Picks what's most useful: the current topic, what's new since the last
  // visit, or simply today.
  function summarySet() {
    const now = Date.now();
    const v = state.variable && state.variables.find((x) => x.id === state.variable);
    if (v) return { items: visibleItems(), label: `${v.name} news`, text: `Summarize ${v.name}` };
    if (state.topic !== 'all') return { items: visibleItems(), label: `${state.topic} news`, text: `Summarize ${state.topic}` };
    const fresh = state.prevVisit ? state.items.filter((i) => ts(i) > state.prevVisit) : [];
    if (fresh.length >= 3) return { items: fresh, label: `since ${relTime(state.prevVisit).toLowerCase()}`, text: `Catch up on ${fresh.length} new stories` };
    let items = state.items.filter((i) => ts(i) >= startOfDay(now));
    if (items.length < 4) items = state.items.filter((i) => now - ts(i) < 24 * 3600e3);
    return { items, label: 'today', text: 'Summarize today' };
  }

  function updateSummaryButton() {
    const { items, text } = summarySet();
    $('#summaryLabel').textContent = text;
    $('#summaryCount').textContent = items.length ? plural(Math.min(items.length, 20), 'story', 'stories') : '';
    $('#summaryBtn').disabled = !items.length;
  }

  function generateSummary() {
    const { items, label } = summarySet();
    if (!items.length) return;
    if (!aiReady()) return openSettings('ai');
    const box = $('#summaryBox');
    box.classList.remove('hidden');
    // Important stories first, then the newest.
    const ranked = [...items].sort((a, b) => (b.importance || 0) - (a.importance || 0) || ts(b) - ts(a));
    streamInto($('.ai-output', box), 'summary', { ids: ranked.slice(0, 20).map((i) => i.id), label }, $('#summaryBtn'));
  }

  // ---------- Ask: chat with saved conversations ----------
  const CHATS_KEY = 'newsroll:chats';
  const chats = loadChats();
  const knownStories = new Map(); // story id → { title, source, link } for stories cited in saved chats

  function loadChats() {
    try {
      const saved = JSON.parse(storage(CHATS_KEY) || 'null');
      if (saved && Array.isArray(saved.list)) return saved;
    } catch {
      /* start fresh */
    }
    return { list: [], currentId: null };
  }

  function saveChats() {
    // Keep the 30 most recent conversations, each up to 40 messages.
    chats.list = chats.list.filter((c) => c.messages.length).slice(0, 30);
    for (const c of chats.list) c.messages = c.messages.slice(-40);
    storage(CHATS_KEY, JSON.stringify(chats));
  }

  function currentChat() {
    let chat = chats.list.find((c) => c.id === chats.currentId);
    if (!chat) {
      chat = { id: `c${Date.now().toString(36)}`, messages: [], updated: Date.now() };
      chats.list.unshift(chat);
      chats.currentId = chat.id;
    }
    return chat;
  }

  const chatTitle = (chat) => chat.messages.find((m) => m.role === 'user')?.text || 'New chat';
  const stripCites = (text) => text.replace(/\s*\[\d+(?:\s*[,&]\s*\d+)*\]/g, '');

  function openSheet() {
    const sheet = $('#sheet');
    if (sheet.classList.contains('open')) return;
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    $('#backdrop').classList.add('show');
    document.body.classList.add('sheet-open');
    showChatView();
  }

  function closeSheet() {
    $('#sheet').classList.remove('open');
    $('#sheet').setAttribute('aria-hidden', 'true');
    $('#backdrop').classList.remove('show');
    document.body.classList.remove('sheet-open');
    $('#askInput').blur();
  }

  function showChatView() {
    $('#historyView').classList.add('hidden');
    $('#chatView').classList.remove('hidden');
    $('#historyBtn').classList.remove('active');
    renderThread();
  }

  function newChat() {
    if (!currentChat().messages.length) return showChatView();
    chats.currentId = null;
    currentChat();
    saveChats();
    showChatView();
    $('#askInput').focus();
  }

  // Sources are stored with each answer so old chats still link up after the
  // stories have scrolled off the timeline.
  function sourceItems(msg) {
    return (msg.sources || []).map((s) => state.byId.get(s.id) || s);
  }

  function aiMessageHtml(msg, i, isLast) {
    const time = new Date(msg.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const canRetry = isLast && msg.question;
    return `
      <div class="msg ai" data-i="${i}">
        <div class="avatar" aria-hidden="true">✦</div>
        <div class="msg-body">
          ${msg.general ? '<span class="tg">general knowledge</span>' : ''}
          <div class="ai-output"></div>
          <div class="qa-after"></div>
          <div class="msg-actions">
            <button class="msg-btn" data-copy="${i}">Copy</button>
            ${canRetry ? `<button class="msg-btn" data-retry="${i}">Retry</button>` : ''}
            <span class="muted">${time}</span>
          </div>
        </div>
      </div>`;
  }

  function renderThread() {
    const chat = currentChat();
    const thread = $('#thread');
    const last = chat.messages.length - 1;
    thread.innerHTML = chat.messages
      .map((m, i) => (m.role === 'user' ? `<div class="msg user"><div class="bubble">${esc(m.text)}</div></div>` : aiMessageHtml(m, i, i === last)))
      .join('');
    chat.messages.forEach((m, i) => {
      if (m.role !== 'ai') return;
      const el = $(`.msg.ai[data-i="${i}"]`, thread);
      for (const s of m.sources || []) knownStories.set(s.id, s);
      renderAi($('.ai-output', el), m.text, sourceItems(m));
      $('.qa-after', el).innerHTML = afterAnswer($('.ai-output', el), m, i === last);
    });
    $('#chatEmpty').classList.toggle('hidden', chat.messages.length > 0);
    $('#chatTitle').innerHTML = chat.messages.length
      ? `<span class="spark">✦</span> ${esc(chatTitle(chat).slice(0, 40))}${chatTitle(chat).length > 40 ? '…' : ''}`
      : '<span class="spark">✦</span> Ask';
    scrollChatToEnd(false);
  }

  function scrollChatToEnd(smooth = true) {
    const view = $('#chatView');
    view.scrollTo({ top: view.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  async function ask(question, { general = false } = {}) {
    openSheet();
    showChatView();
    const chat = currentChat();
    // The last couple of answers go along so follow-ups ("why?") make sense.
    const history = [];
    for (let i = 0; i < chat.messages.length - 1; i++) {
      const [q, a] = [chat.messages[i], chat.messages[i + 1]];
      if (q.role === 'user' && a.role === 'ai' && a.mode !== 'direct') history.push({ q: q.text, a: stripCites(a.text).slice(0, 600) });
    }
    chat.messages.push({ role: 'user', text: question, at: Date.now() });
    chat.updated = Date.now();
    renderThread();

    // Placeholder bubble that the reply streams into.
    const thread = $('#thread');
    thread.insertAdjacentHTML('beforeend', `<div class="msg ai streaming"><div class="avatar" aria-hidden="true">✦</div><div class="msg-body"><div class="ai-output"></div></div></div>`);
    const pending = thread.lastElementChild;
    scrollChatToEnd();
    const ids = state.topic === 'all' ? [] : visibleItems().map((i) => i.id);
    const follow = new MutationObserver(() => nearBottom() && scrollChatToEnd(false));
    follow.observe(pending, { childList: true, subtree: true, characterData: true });
    const r = await streamInto($('.ai-output', pending), 'ask', { question, ids, history: history.slice(-2), general });
    follow.disconnect();
    if (!r) {
      pending.classList.remove('streaming');
      return;
    }
    chat.messages.push({
      role: 'ai',
      text: r.text,
      mode: r.mode,
      groups: r.groups,
      general,
      question,
      at: Date.now(),
      sources: r.sources.map((s) => ({ id: s.id, title: s.title, source: s.source, link: s.link })),
    });
    chat.updated = Date.now();
    saveChats();
    renderThread();
    scrollChatToEnd();
  }

  const nearBottom = () => {
    const v = $('#chatView');
    return v.scrollHeight - v.scrollTop - v.clientHeight < 120;
  };

  // What to show under an answer: its sources, or ways forward if nothing was found.
  function afterAnswer(out, msg, isLast) {
    const notFound = msg.mode === 'notfound' || (msg.mode === 'answer' && /couldn['’]t find|don['’]t cover|no (story|stories) (answer|mention)/i.test(msg.text));
    if (notFound) {
      $$('.cite', out).forEach((c) => c.remove()); // a "not found" reply shouldn't cite anything
      if (!isLast) return '';
      const groupBtns = (msg.groups || [])
        .map((g) => `<button class="pill-btn" data-open-group="${esc(g)}">Turn on ${esc(g)} sources</button>`)
        .join('');
      return `<div class="qa-actions">${groupBtns}<button class="pill-btn ai" data-ask-general="${esc(msg.question || '')}"><span class="spark">✦</span> Ask the AI anyway</button></div>
        <p class="qa-note">“Ask anyway” answers from the AI's own knowledge, which may be out of date.</p>`;
    }
    if (msg.general) return '<p class="qa-note">From the AI\'s general knowledge, not your news. It may be out of date.</p>';
    if (msg.mode !== 'answer' || !msg.sources?.length) return '';

    // List the stories the answer cited, or the top matches if it cited none.
    const items = sourceItems(msg);
    const cited = [...new Set([...msg.text.matchAll(/\[(\d+(?:\s*[,&]\s*\d+)*)\]/g)].flatMap((m) => m[1].split(/[,&]/).map((n) => Number(n.trim()))))]
      .map((n) => ({ n, it: items[n - 1] }))
      .filter((c) => c.it);
    const list = cited.length ? cited : items.slice(0, 3).map((it, i) => ({ n: i + 1, it }));
    const followUps = isLast
      ? `<div class="follow-ups">${['Tell me more', 'Why does it matter?', 'What happens next?'].map((q) => `<button class="chip" data-follow="${q}">${q}</button>`).join('')}</div>`
      : '';
    return `<details class="qa-sources"${isLast ? ' open' : ''}><summary>${plural(list.length, 'source')}</summary>${list
      .map(({ n, it }) => `<button data-jump="${it.id}"><span class="n">${n}</span><span>${esc(it.title)} <span class="muted">· ${esc(it.source)}</span></span></button>`)
      .join('')}</details>${followUps}`;
  }

  // ----- Past chats -----
  function showHistory() {
    $('#chatView').classList.add('hidden');
    $('#historyView').classList.remove('hidden');
    $('#historyBtn').classList.add('active');
    $('#chatTitle').innerHTML = 'Past chats';
    $('#historySearch').value = '';
    renderHistory();
    $('#historySearch').focus();
  }

  function renderHistory() {
    const q = $('#historySearch').value.trim().toLowerCase();
    const list = chats.list
      .filter((c) => c.messages.length)
      .filter((c) => !q || c.messages.some((m) => m.text.toLowerCase().includes(q)))
      .sort((a, b) => b.updated - a.updated);
    $('#historyList').innerHTML = list.length
      ? list
          .map((c) => {
            const lastAi = [...c.messages].reverse().find((m) => m.role === 'ai');
            const asks = c.messages.filter((m) => m.role === 'user').length;
            return `
              <div class="hist-row${c.id === chats.currentId ? ' current' : ''}" data-chat="${c.id}" role="button" tabindex="0">
                <div class="hist-main">
                  <div class="hist-title">${esc(chatTitle(c))}</div>
                  <div class="hist-preview muted">${esc(stripCites(lastAi?.text || '').slice(0, 110))}</div>
                </div>
                <div class="hist-meta muted">${relTime(c.updated)}<br>${plural(asks, 'question')}</div>
                <button class="close-btn hist-del" data-del-chat="${c.id}" aria-label="Delete chat">×</button>
              </div>`;
          })
          .join('') + '<button class="link-btn hist-clear" id="clearChats">Delete all chats</button>'
      : `<p class="muted">${q ? `No chats mention “${esc(q)}”.` : 'No past chats yet.'}</p>`;
  }

  $('#historySearch').addEventListener('input', renderHistory);
  $('#historyList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-chat]');
    if (del) {
      chats.list = chats.list.filter((c) => c.id !== del.dataset.delChat);
      if (chats.currentId === del.dataset.delChat) chats.currentId = null;
      saveChats();
      return renderHistory();
    }
    if (e.target.closest('#clearChats')) {
      if (!confirm('Delete all past chats?')) return;
      chats.list = [];
      chats.currentId = null;
      saveChats();
      return renderHistory();
    }
    const row = e.target.closest('[data-chat]');
    if (row) {
      chats.currentId = row.dataset.chat;
      showChatView();
    }
  });

  $('#thread').addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const msg = currentChat().messages[Number(copy.dataset.copy)];
      try {
        await navigator.clipboard.writeText(stripCites(msg.text));
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Copy failed';
      }
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
      return;
    }
    const retry = e.target.closest('[data-retry]');
    if (retry) {
      const chat = currentChat();
      const i = Number(retry.dataset.retry);
      const { question, general } = chat.messages[i];
      chat.messages.splice(i - 1, 2); // drop the question and answer, then ask again
      return ask(question, { general });
    }
    const follow = e.target.closest('[data-follow]');
    if (follow) return ask(follow.dataset.follow);
  });

  $('#chatView').addEventListener('scroll', () => $('#jumpLatest').classList.toggle('hidden', nearBottom()), { passive: true });
  $('#jumpLatest').addEventListener('click', () => scrollChatToEnd());
  $('#historyBtn').addEventListener('click', () => ($('#historyView').classList.contains('hidden') ? showHistory() : showChatView()));
  $('#newChatBtn').addEventListener('click', newChat);

  // Rainbow highlight while typing to the AI.
  const updateTyping = () => $('#askForm').classList.toggle('typing', document.activeElement === $('#askInput') && $('#askInput').value.length > 0);
  $('#askInput').addEventListener('input', updateTyping);
  $('#askInput').addEventListener('blur', updateTyping);
  // ↑ in the empty box brings back your last question.
  $('#askInput').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' || e.target.value) return;
    const lastQ = [...currentChat().messages].reverse().find((m) => m.role === 'user');
    if (lastQ) {
      e.preventDefault();
      e.target.value = lastQ.text;
      updateTyping();
    }
  });

  // ---------- AI status ----------
  let statusTimer;
  async function checkAi() {
    const note = $('#aiNote');
    try {
      const s = await (await fetch('/api/ai/status')).json();
      state.ai = s;
      const ready = s.online && s.installed;
      $('#aiSpark').classList.toggle('off', !ready);
      note.classList.toggle('hidden', ready);
      note.innerHTML = `<span>${s.online ? `The AI model <b>${esc(s.model)}</b> isn't downloaded yet.` : 'The AI is switched off.'}</span>
        <button class="pill-btn ai" data-open-settings="ai"><span class="spark">✦</span> Set up AI</button>`;
      if ($('#settings').classList.contains('open') && state.tab === 'ai') renderAiTab();
      clearTimeout(statusTimer);
      if (!ready) statusTimer = setTimeout(checkAi, 15000);
    } catch {
      /* status is best-effort */
    }
  }

  // ---------- Scroll effects ----------
  let scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      document.body.classList.toggle('scrolled', scrollY > 8);
      // The timeline line "fills" as you read down through it.
      const tl = $('#timeline');
      const r = tl.getBoundingClientRect();
      const fill = Math.min(1, Math.max(0, (innerHeight * 0.6 - r.top) / r.height));
      tl.style.setProperty('--fill', fill.toFixed(4));
    });
  }

  // ---------- Keyboard navigation ----------
  function moveFocus(dir) {
    const items = $$('.tl-item');
    if (!items.length) return;
    const current = document.activeElement?.closest?.('.tl-item');
    let idx = current ? items.indexOf(current) + dir : 0;
    idx = Math.max(0, Math.min(items.length - 1, idx));
    const el = items[idx];
    el.classList.add('in');
    $('.tl-card', el).focus({ preventScroll: true });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------- Events ----------
  document.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) return jumpTo(jump.dataset.jump);

    const filter = e.target.closest('.filter');
    if (filter) return setTopic(filter.dataset.topic);

    if (e.target.closest('[data-clear-var]')) return setVariableFilter(null);

    const groupBtn = e.target.closest('[data-open-group]');
    if (groupBtn) return openSettings('sources', groupBtn.dataset.openGroup);
    const general = e.target.closest('[data-ask-general]');
    if (general) {
      general.closest('.qa-after').innerHTML = ''; // the follow-up answer appears below
      return ask(general.dataset.askGeneral, { general: true });
    }

    const opener = e.target.closest('[data-open-settings]');
    if (opener) return openSettings(opener.dataset.openSettings);

    const explain = e.target.closest('.explain-btn');
    if (explain && !aiReady()) return openSettings('ai');
    if (explain) {
      const item = explain.closest('.tl-item');
      let out = $('.tl-explain .ai-output', item);
      if (!out) {
        out = document.createElement('div');
        out.className = 'ai-output';
        $('.tl-explain', item).append(out);
      }
      return streamInto(out, 'explain', { id: item.dataset.id }, explain);
    }

    const daySum = e.target.closest('.day-sum');
    if (daySum && !aiReady()) return openSettings('ai');
    if (daySum) {
      const day = Number(daySum.closest('.day').dataset.day);
      const box = $(`[data-day-summary="${day}"]`);
      box.classList.remove('hidden');
      const items = visibleItems().filter((i) => startOfDay(ts(i)) === day);
      const label = `${dayLabel(day).toLowerCase()}${state.topic !== 'all' ? ` (${state.topic})` : ''}`;
      return streamInto($('.ai-output', box), 'summary', { ids: items.slice(0, 20).map((i) => i.id), label }, daySum);
    }

    if (e.target.closest('a, button, .tl-more-inner')) return;
    const card = e.target.closest('.tl-card');
    if (card) toggleItem(card.closest('.tl-item'));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#varModal').classList.contains('hidden')) return closeVarModal();
      if ($('#settings').classList.contains('open')) return closeSettings();
      if ($('#sheet').classList.contains('open') && !$('#historyView').classList.contains('hidden')) return showChatView();
      if ($('#sheet').classList.contains('open')) return closeSheet();
      if (!$('#searchbar').classList.contains('hidden')) return closeSearch();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#askInput').focus(); return; }
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); openSearch(); return; }
    if (typing) return;
    if (e.key === 'j') moveFocus(1);
    else if (e.key === 'k') moveFocus(-1);
    else if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.classList.contains('tl-card')) {
      e.preventDefault();
      toggleItem(document.activeElement.closest('.tl-item'));
    }
  });

  $('#summaryBtn').addEventListener('click', generateSummary);
  $('#summaryClose').addEventListener('click', () => {
    const out = $('#summaryBox .ai-output');
    streams.get(out)?.abort();
    $('#summaryBox').classList.add('hidden');
  });

  $('#askInput').addEventListener('focus', openSheet);
  $('#askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#askInput');
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    ask(question);
  });
  $('#suggestions').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) ask(chip.textContent);
  });
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#backdrop').addEventListener('click', closeSheet);

  $('#refreshBtn').addEventListener('click', () => loadFeed({ force: true }));
  $('#newPill').addEventListener('click', applyPending);
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);

  // Keep relative timestamps and the greeting fresh.
  setInterval(() => {
    $$('.tl-item time').forEach((t) => (t.textContent = relTime(Date.parse(t.dateTime))));
    renderMasthead();
  }, 60000);

  // ---------- Search ----------
  function openSearch() {
    $('#searchbar').classList.remove('hidden');
    $('#searchInput').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeSearch() {
    $('#searchbar').classList.add('hidden');
    if (state.query) {
      state.query = '';
      $('#searchInput').value = '';
      render();
    }
  }

  let searchTimer;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value;
      render();
    }, 150);
  });
  $('#searchBtn').addEventListener('click', () => ($('#searchbar').classList.contains('hidden') ? openSearch() : closeSearch()));
  $('#searchClose').addEventListener('click', closeSearch);

  // ---------- Welcome (first run) ----------
  const WELCOME_KEY = 'newsroll:welcomed';
  if (!storage(WELCOME_KEY)) $('#welcome').classList.remove('hidden');
  $('#welcomeDismiss').addEventListener('click', () => {
    storage(WELCOME_KEY, '1');
    $('#welcome').classList.add('hidden');
  });

  // ---------- Settings panel ----------
  state.tab = 'sources';
  let sourcesData = null;
  let sourcesChanged = false;
  const openGroups = new Set(['Added by you', 'Telegram']);

  let focusGroup = null;
  function openSettings(tab = state.tab, group = null) {
    focusGroup = group;
    if (group) openGroups.add(group);
    closeSheet();
    storage(WELCOME_KEY, '1');
    $('#welcome').classList.add('hidden');
    const panel = $('#settings');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    $('#panelBackdrop').classList.add('show');
    document.body.classList.add('sheet-open');
    showTab(tab);
  }

  function closeSettings() {
    const panel = $('#settings');
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    $('#panelBackdrop').classList.remove('show');
    document.body.classList.remove('sheet-open');
    if (sourcesChanged) {
      sourcesChanged = false;
      loadFeed({ force: true, initial: true });
    }
  }

  function showTab(tab) {
    state.tab = tab;
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#tab-sources').classList.toggle('hidden', tab !== 'sources');
    $('#tab-ai').classList.toggle('hidden', tab !== 'ai');
    if (tab === 'sources') loadSources();
    else checkAi().then(renderAiTab);
  }

  // ----- Sources tab -----
  async function loadSources() {
    if (!sourcesData) $('#sourceList').innerHTML = '<p class="muted">Loading sources…</p>';
    sourcesData = await (await fetch('/api/sources')).json();
    renderSources();
    if (focusGroup) {
      $(`.group[data-group="${CSS.escape(focusGroup)}"]`)?.scrollIntoView({ block: 'start' });
      focusGroup = null;
    }
  }

  function statusText(src) {
    if (!src.enabled) return '';
    if (!src.status) return '<span class="st">Not loaded yet</span>';
    return src.status.ok
      ? `<span class="st ok">${plural(src.status.count, 'story', 'stories')}</span>`
      : `<span class="st bad" title="${esc(src.status.error)}">Couldn't load</span>`;
  }

  function renderSources() {
    const { groups, sources } = sourcesData;
    const q = $('#sourceSearch').value.trim().toLowerCase();
    const on = sources.filter((s) => s.enabled).length;
    $('#sourceCount').textContent = `${on} of ${sources.length} on`;

    // Put the user's own sources and Telegram near the top.
    const order = ['Added by you', 'Top stories', 'Telegram', ...groups.filter((g) => !['Added by you', 'Top stories', 'Telegram'].includes(g))];
    $('#sourceList').innerHTML = order
      .map((group) => {
        const list = sources.filter((s) => s.group === group && (!q || `${s.name} ${s.url}`.toLowerCase().includes(q)));
        if (!list.length) return '';
        const groupOn = list.filter((s) => s.enabled).length;
        const open = q || openGroups.has(group);
        return `
          <details class="group" data-group="${esc(group)}" ${open ? 'open' : ''}>
            <summary>
              <span class="group-name">${esc(group)}${group === 'Telegram' ? ' <span class="tg">channels</span>' : ''}</span>
              <span class="muted small">${groupOn} of ${list.length} on</span>
              <button class="link-btn group-toggle" data-ids="${list.map((s) => s.id).join(',')}" data-on="${groupOn < list.length}">${groupOn < list.length ? 'Turn all on' : 'Turn all off'}</button>
            </summary>
            ${list
              .map(
                (s) => `
              <label class="source-row">
                <input type="checkbox" class="switch" data-id="${s.id}" ${s.enabled ? 'checked' : ''} />
                <span class="source-name">${esc(s.name)}</span>
                ${s.type === 'telegram' ? `<span class="tg">${esc('@' + s.url)}</span>` : ''}
                ${statusText(s)}
                ${s.custom ? `<button class="close-btn remove-source" data-id="${s.id}" title="Remove" aria-label="Remove ${esc(s.name)}">×</button>` : ''}
              </label>`,
              )
              .join('')}
          </details>`;
      })
      .join('') || `<p class="muted">No sources match “${esc(q)}”. You can add it above.</p>`;
  }

  async function setSources(ids, enabled) {
    sourcesChanged = true;
    for (const s of sourcesData.sources) if (ids.includes(s.id)) s.enabled = enabled;
    renderSources();
    await fetch('/api/sources', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, enabled }) });
  }

  $('#sourceList').addEventListener('change', (e) => {
    if (e.target.matches('.switch')) setSources([e.target.dataset.id], e.target.checked);
  });

  $('#sourceList').addEventListener('click', async (e) => {
    const toggle = e.target.closest('.group-toggle');
    if (toggle) {
      e.preventDefault();
      return setSources(toggle.dataset.ids.split(','), toggle.dataset.on === 'true');
    }
    const remove = e.target.closest('.remove-source');
    if (remove) {
      e.preventDefault();
      sourcesChanged = true;
      await fetch(`/api/sources/${remove.dataset.id}`, { method: 'DELETE' });
      loadSources();
    }
  });

  // Remember which groups are expanded.
  $('#sourceList').addEventListener('toggle', (e) => {
    const g = e.target.dataset?.group;
    if (g) e.target.open ? openGroups.add(g) : openGroups.delete(g);
  }, true);

  $('#sourceSearch').addEventListener('input', () => sourcesData && renderSources());

  $('#addSourceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#addSourceInput');
    const msg = $('#addSourceMsg');
    const btn = $('#addSourceForm button');
    if (!input.value.trim()) return input.focus();
    btn.disabled = true;
    msg.className = 'hint';
    msg.textContent = 'Checking…';
    try {
      const res = await fetch('/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: input.value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      sourcesChanged = true;
      openGroups.add(data.source.group);
      input.value = '';
      msg.className = data.warning && !data.source.existed ? 'hint warn' : 'hint ok';
      msg.textContent = data.source.existed
        ? `${data.source.name} is already in your list, so it's been switched on.`
        : `Added ${data.source.name}.${data.warning ? ` ${data.warning}` : ''}`;
      loadSources();
    } catch (err) {
      msg.className = 'hint warn';
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ----- AI tab -----
  const pulls = {}; // model -> { pct, status, error }
  const gb = (bytes) => (bytes ? `${(bytes / 1e9).toFixed(1)} GB` : '');

  function renderAiTab() {
    const s = state.ai;
    const el = $('#tab-ai');
    if (!s) {
      el.innerHTML = '<p class="muted">Checking…</p>';
      return;
    }
    if (!s.online) {
      el.innerHTML = `
        <div class="setup">
          <h3>Turn on AI in three steps</h3>
          <p class="muted">Newsroll's AI runs privately on your own computer using a free app called Ollama. Nothing you read or ask leaves your machine.</p>
          <ol class="steps">
            <li><b>Download Ollama</b>. It's free.<br><a class="pill-btn solid" href="https://ollama.com/download" target="_blank" rel="noopener">Download Ollama ↗</a></li>
            <li><b>Install and open it.</b> It runs quietly in the background.</li>
            <li><b>Come back here</b> and pick a model to download.<br><button class="pill-btn" id="aiRetry">Check again</button></li>
          </ol>
        </div>`;
      return;
    }

    const installed = s.models || [];
    const isInstalled = (name) => installed.some((m) => sameModel(m.name, name));
    const current = s.model;

    const installedHtml = installed.length
      ? installed
          .map(
            (m) => `
          <label class="model-row${sameModel(m.name, current) ? ' current' : ''}">
            <input type="radio" name="model" value="${esc(m.name)}" ${sameModel(m.name, current) ? 'checked' : ''} />
            <span class="model-name">${esc(m.name)}</span>
            <span class="muted small">${esc([m.params, gb(m.size)].filter(Boolean).join(' · '))}</span>
          </label>`,
          )
          .join('')
      : '<p class="muted">No models downloaded yet. Pick one below. SmolLM2 is a good start.</p>';

    const recHtml = s.recommended
      .map((r) => {
        const p = pulls[r.name];
        const have = isInstalled(r.name);
        let action;
        if (p && !p.error && !p.done) action = `<div class="progress"><i style="width:${p.pct || 0}%"></i></div><span class="muted small">${esc(p.status || 'Starting…')}${p.pct ? ` · ${p.pct}%` : ''}</span>`;
        else if (have && sameModel(r.name, current)) action = '<span class="st ok">In use</span>';
        else if (have) action = `<button class="pill-btn" data-use="${esc(r.name)}">Use</button>`;
        else action = `<button class="pill-btn ai" data-pull="${esc(r.name)}">Download · ${esc(r.size)}</button>`;
        return `
          <div class="rec-row">
            <div><div class="model-name">${esc(r.label)} <span class="muted small">${esc(r.name)}</span>${r.recommended ? ' <span class="badge">Recommended</span>' : ''}</div><div class="muted small">${esc(r.note)}</div>
            ${p?.error ? `<div class="hint warn">${esc(p.error)}</div>` : ''}</div>
            <div class="rec-action">${action}</div>
          </div>`;
      })
      .join('');

    el.innerHTML = `
      <div class="ai-current ${isInstalled(current) ? 'ok' : 'warn'}">
        <span class="spark">✦</span>
        <div><b>${esc(current)}</b><div class="muted small">${isInstalled(current) ? 'Ready. Used for summaries, answers and explanations.' : 'Selected, but not downloaded yet. Download it below or pick another.'}</div></div>
      </div>
      ${/^smollm2/.test(current) ? `<p class="hint">Tip: ${esc(current)} is tiny, so it sometimes misses things. For noticeably better answers, download <b>Qwen 2.5</b> below (1.9 GB).</p>` : ''}
      <h3>Your models</h3>
      <div class="model-list">${installedHtml}</div>
      <h3>Get more models</h3>
      <div class="rec-list">${recHtml}</div>
      <form class="add-source" id="customModelForm" autocomplete="off">
        <input id="customModel" placeholder="Or type any Ollama model name, e.g. llama3.1:8b" />
        <button class="pill-btn" type="submit">Download</button>
      </form>
      <p class="hint">Bigger models give better answers but are slower. Browse all models at <a href="https://ollama.com/library" target="_blank" rel="noopener">ollama.com/library</a>.</p>`;
  }

  function sameModel(a, b) {
    const tag = (n) => (n.includes(':') ? n : `${n}:latest`);
    return tag(a) === tag(b);
  }

  async function useModel(name) {
    const res = await fetch('/api/ai/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }) });
    state.ai = await res.json();
    await checkAi();
    renderAiTab();
  }

  async function pullModel(name) {
    pulls[name] = { status: 'Starting download…' };
    renderAiTab();
    try {
      const res = await fetch('/api/ai/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }) });
      if (!res.ok) throw new Error((await res.json()).error);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let last = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const p = JSON.parse(line);
          if (p.error) throw new Error(p.error);
          const status = p.status === 'success' ? 'Finishing…' : /^pulling [0-9a-f]{6,}/.test(p.status || '') ? 'Downloading' : p.status;
          pulls[name] = { status, pct: p.total ? Math.floor((p.completed / p.total) * 100) : pulls[name].pct, done: p.done };
        }
        // Re-render at most a few times a second.
        if (Date.now() - last > 250 && state.tab === 'ai') {
          last = Date.now();
          renderAiTab();
        }
      }
      delete pulls[name];
      await useModel(name); // switch to it straight away: that's almost always what you want
    } catch (err) {
      pulls[name] = { error: `Download failed: ${err.message}` };
      renderAiTab();
    }
  }

  $('#tab-ai').addEventListener('change', (e) => {
    if (e.target.name === 'model') useModel(e.target.value);
  });
  $('#tab-ai').addEventListener('click', (e) => {
    const pull = e.target.closest('[data-pull]');
    if (pull) return pullModel(pull.dataset.pull);
    const use = e.target.closest('[data-use]');
    if (use) return useModel(use.dataset.use);
    if (e.target.closest('#aiRetry')) {
      e.target.textContent = 'Checking…';
      checkAi().then(renderAiTab);
    }
  });
  $('#tab-ai').addEventListener('submit', (e) => {
    if (e.target.id !== 'customModelForm') return;
    e.preventDefault();
    const name = $('#customModel').value.trim();
    if (name) pullModel(name);
  });

  $$('.tab-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#panelBackdrop').addEventListener('click', closeSettings);

  // Lets the desktop app's menu open these screens.
  window.newsroll = { openSettings };

  // ---------- Variables: pinned trackers ----------
  // Each variable has keywords; a story matches if it contains every word of
  // any one keyword (so "rate cut" needs both words, "drone, uav" needs either).
  const PRESETS = [
    { name: 'Drone strikes', keywords: ['drone', 'uav', 'shahed', 'unmanned aerial'] },
    { name: 'Missile launches', keywords: ['missile', 'ballistic', 'icbm', 'rocket fire'] },
    { name: 'Earthquakes', keywords: ['earthquake', 'quake', 'tremor', 'seismic'] },
    { name: 'Wildfires', keywords: ['wildfire', 'bushfire', 'forest fire'] },
    { name: 'Storms', keywords: ['hurricane', 'typhoon', 'cyclone', 'tropical storm', 'tornado'] },
    { name: 'Ceasefire talks', keywords: ['ceasefire', 'truce', 'peace talk'] },
    { name: 'Interest rates', keywords: ['interest rate', 'rate cut', 'rate hike', 'federal reserve', 'central bank'] },
    { name: 'Bitcoin', keywords: ['bitcoin', 'btc', 'crypto'] },
    { name: 'AI', keywords: ['ai', 'artificial intelligence', 'openai', 'chatgpt', 'anthropic'] },
    { name: 'Elections', keywords: ['election', 'ballot', 'vote count', 'polling station'] },
    { name: 'Protests', keywords: ['protest', 'protester', 'demonstrator', 'riot'] },
    { name: 'Cyberattacks', keywords: ['cyberattack', 'ransomware', 'data breach', 'hacker'] },
    { name: 'Space launches', keywords: ['spacex', 'starship', 'rocket launch', 'nasa launch'] },
    { name: 'Layoffs', keywords: ['layoff', 'job cut', 'redundancy'] },
  ];

  state.variables = [];
  state.variable = null; // id of the variable filtering the timeline

  // Same light stemming as the server's search, so "drones" matches "drone".
  function stemWord(w) {
    if (w.length <= 3) return w;
    if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
    if (/(ss|us|is)$/.test(w)) return w;
    if (/(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
    if (w.endsWith('s')) return w.slice(0, -1);
    if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
    if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
    return w;
  }
  const stems = (text) => (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).map(stemWord);
  const stemCache = new Map();
  function storyStems(it) {
    if (!stemCache.has(it.id)) stemCache.set(it.id, new Set(stems(`${it.title} ${it.summary || ''}`)));
    return stemCache.get(it.id);
  }

  function compileVariable(v) {
    return v.keywords.map((k) => stems(k)).filter((ws) => ws.length);
  }
  function matchesVariable(compiled, it) {
    const set = storyStems(it);
    return compiled.some((ws) => ws.every((w) => set.has(w)));
  }
  const variableItems = (v) => {
    const compiled = compileVariable(v);
    return state.items.filter((it) => matchesVariable(compiled, it));
  };

  function variableStats(v) {
    const now = Date.now();
    const matches = variableItems(v);
    const age = (it) => (now - ts(it)) / 3600e3;
    const day = matches.filter((it) => age(it) < 24);
    const prev = matches.filter((it) => age(it) >= 24 && age(it) < 48);
    // 24 bars of two hours each, covering the last 48 hours (oldest first).
    const bars = Array(24).fill(0);
    for (const it of matches) {
      const slot = Math.floor(age(it) / 2);
      if (slot >= 0 && slot < 24) bars[23 - slot]++;
    }
    const spiking = day.length >= 3 && day.length >= prev.length * 2;
    return { matches, day: day.length, prev: prev.length, bars, latest: matches[0], spiking, important: matches.some((it) => it.importance > 0 && age(it) < 24) };
  }

  function sparkline(bars) {
    const max = Math.max(1, ...bars);
    const w = 3;
    const gap = 1;
    return `<svg class="spark-bars" viewBox="0 0 ${bars.length * (w + gap)} 20" preserveAspectRatio="none" aria-hidden="true">${bars
      .map((b, i) => {
        const h = b ? Math.max(2, (b / max) * 20) : 1;
        return `<rect x="${i * (w + gap)}" y="${20 - h}" width="${w}" height="${h}" rx="1" class="${i >= 12 ? 'recent' : ''}"/>`;
      })
      .join('')}</svg>`;
  }

  function renderVariables() {
    const el = $('#vars');
    if (!state.variables.length) {
      el.innerHTML = `
        <div class="vars-empty">
          <div><b>Pin a variable</b> <span class="muted">to track something across all your news, e.g.</span></div>
          <div class="preset-chips">${PRESETS.slice(0, 5).map((p) => `<button class="chip" data-preset="${esc(p.name)}">+ ${esc(p.name)}</button>`).join('')}<button class="chip" data-add-var>+ Your own…</button></div>
        </div>`;
      return;
    }
    el.innerHTML =
      state.variables
        .map((v) => {
          const s = variableStats(v);
          const delta = s.day - s.prev;
          const badge = s.spiking || s.important;
          const deltaText = delta === 0 ? 'same as yesterday' : `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}${badge ? '' : ' vs yesterday'}`;
          const deltaHtml = `<span class="var-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}" title="${s.day} in the last 24h, ${s.prev} the day before">${deltaText}</span>`;
          return `
            <div class="var-card${state.variable === v.id ? ' active' : ''}${s.spiking ? ' spiking' : ''}" data-var="${v.id}" role="button" tabindex="0" title="Show these stories">
              <div class="var-top">
                <span class="var-name">${esc(v.name)}</span>
                <button class="var-x" data-del-var="${v.id}" aria-label="Unpin ${esc(v.name)}" title="Unpin">×</button>
              </div>
              <div class="var-mid">
                <span class="var-count">${s.day}</span>
                <span class="var-unit">${s.day === 1 ? 'report' : 'reports'}<br>last 24h</span>
                ${sparkline(s.bars)}
              </div>
              <div class="var-foot">${s.spiking ? '<span class="imp breaking">Spiking</span>' : s.important ? '<span class="imp">Important</span>' : ''}${deltaHtml}<button class="var-ai" data-var-ai="${v.id}" title="AI status update" aria-label="AI status for ${esc(v.name)}">✦</button></div>
              <div class="var-latest">${s.latest ? `<span class="muted">${relTime(ts(s.latest))}</span> ${esc(s.latest.title)}` : '<span class="muted">No reports yet</span>'}</div>
            </div>`;
        })
        .join('') + '<button class="var-add" data-add-var aria-label="Pin a variable"><span>+</span>Pin</button>';
  }

  async function loadVariables() {
    try {
      state.variables = (await (await fetch('/api/variables')).json()).variables || [];
    } catch {
      state.variables = [];
    }
    renderVariables();
  }

  async function saveVariables() {
    renderVariables();
    await fetch('/api/variables', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variables: state.variables }) });
  }

  function addVariable(v) {
    const existing = state.variables.find((x) => x.name.toLowerCase() === v.name.toLowerCase());
    if (existing) existing.keywords = v.keywords;
    else state.variables.push({ id: `v${Date.now().toString(36)}`, ...v });
    saveVariables();
  }

  function setVariableFilter(id) {
    state.variable = state.variable === id ? null : id;
    renderVariables();
    render();
    if (state.variable) window.scrollTo({ top: $('#filters').offsetTop - 70, behavior: 'smooth' });
  }

  function renderVarFilter(count) {
    const v = state.variables.find((x) => x.id === state.variable);
    const bar = $('#varFilter');
    bar.classList.toggle('hidden', !v);
    if (v) bar.innerHTML = `Showing <b>${esc(v.name)}</b> · ${plural(count, 'story', 'stories')} <button class="link-btn" data-clear-var>Show all</button>`;
  }

  // ----- Pin dialog -----
  function openVarModal(preset) {
    const modal = $('#varModal');
    modal.classList.remove('hidden');
    $('#varPresets').innerHTML = PRESETS.filter((p) => !state.variables.some((v) => v.name === p.name))
      .map((p) => `<button type="button" class="chip" data-fill-preset="${esc(p.name)}">${esc(p.name)}</button>`)
      .join('');
    $('#varName').value = preset?.name || '';
    $('#varKeywords').value = preset ? preset.keywords.join(', ') : '';
    updateVarPreview();
    $('#varName').focus();
  }
  const closeVarModal = () => $('#varModal').classList.add('hidden');

  function formVariable() {
    const name = $('#varName').value.trim();
    const keywords = ($('#varKeywords').value.trim() || name).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    return { name, keywords };
  }

  function updateVarPreview() {
    const v = formVariable();
    const preview = $('#varPreview');
    if (!v.name) {
      preview.textContent = 'Tip: a keyword with several words needs all of them, e.g. “rate cut”.';
      return;
    }
    const s = variableStats(v);
    preview.innerHTML = `Matches <b>${plural(s.day, 'story', 'stories')}</b> in the last 24 hours${s.latest ? `, latest: “${esc(s.latest.title.slice(0, 70))}”` : ''}.`;
  }

  $('#varName').addEventListener('input', updateVarPreview);
  $('#varKeywords').addEventListener('input', updateVarPreview);
  $('#varCancel').addEventListener('click', closeVarModal);
  $('#varModal').addEventListener('click', (e) => {
    if (e.target.id === 'varModal') return closeVarModal();
    const fill = e.target.closest('[data-fill-preset]');
    if (fill) {
      const p = PRESETS.find((x) => x.name === fill.dataset.fillPreset);
      $('#varName').value = p.name;
      $('#varKeywords').value = p.keywords.join(', ');
      updateVarPreview();
    }
  });
  $('#varForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formVariable();
    if (!v.name) return;
    addVariable(v);
    closeVarModal();
  });

  $('#vars').addEventListener('click', (e) => {
    const preset = e.target.closest('[data-preset]');
    if (preset) return addVariable(PRESETS.find((p) => p.name === preset.dataset.preset));
    if (e.target.closest('[data-add-var]')) return openVarModal();
    const del = e.target.closest('[data-del-var]');
    if (del) {
      e.stopPropagation();
      state.variables = state.variables.filter((v) => v.id !== del.dataset.delVar);
      if (state.variable === del.dataset.delVar) setVariableFilter(null);
      return saveVariables();
    }
    const aiBtn = e.target.closest('[data-var-ai]');
    if (aiBtn) {
      e.stopPropagation();
      const v = state.variables.find((x) => x.id === aiBtn.dataset.varAi);
      if (!aiReady()) return openSettings('ai');
      const box = $('#varStatus');
      box.classList.remove('hidden');
      $('#varStatusTitle').innerHTML = `<span class="spark">✦</span> ${esc(v.name)} — latest`;
      const ids = variableStats(v).matches.slice(0, 8).map((it) => it.id);
      return streamInto($('.ai-output', box), 'status', { ids, name: v.name }, aiBtn);
    }
    const card = e.target.closest('[data-var]');
    if (card) setVariableFilter(card.dataset.var);
  });
  $('#vars').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-var]')) {
      e.preventDefault();
      setVariableFilter(e.target.dataset.var);
    }
  });
  $('#varStatusClose').addEventListener('click', () => {
    streams.get($('#varStatus .ai-output'))?.abort();
    $('#varStatus').classList.add('hidden');
  });

  // ---------- Boot ----------
  renderMasthead();
  const sk = $('#skeletonTpl');
  $('#timelineBody').append(...Array.from({ length: 6 }, () => sk.content.cloneNode(true)));

  loadVariables();
  loadFeed({ initial: true }).then(() => storage(VISIT_KEY, String(Date.now())));
  checkAi();
  setInterval(() => loadFeed(), REFRESH_MS);

  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
