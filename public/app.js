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
    if (state.topic === 'Telegram') list = list.filter((it) => it.type === 'telegram');
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
    if (state.topic !== 'all' && !counts[state.topic] && !(state.topic === 'Telegram' && hasTelegram)) state.topic = 'all';
    $('#filters').innerHTML = ['all', ...(hasTelegram ? ['Telegram'] : []), ...topics]
      .map((t) => `<button class="filter${state.topic === t ? ' active' : ''}" data-topic="${esc(t)}">${t === 'all' ? 'All' : esc(t)}</button>`)
      .join('');
  }

  function itemHtml(it) {
    const t = ts(it);
    const fresh = state.prevVisit && t > state.prevVisit;
    return `
      <article class="tl-item${fresh ? ' fresh' : ''}" data-id="${it.id}" tabindex="-1">
        <span class="tl-dot"></span>
        <div class="tl-card" role="button" tabindex="0" aria-expanded="false">
          <div class="tl-meta"><time datetime="${esc(it.published)}">${relTime(t)}</time> · ${esc(it.source)}${it.type === 'telegram' ? ' <span class="tg">Telegram</span>' : ''}${fresh ? ' · <b>New</b>' : ''}</div>
          <h3 class="tl-title">${esc(it.title)}</h3>
          <div class="tl-more"><div><div class="tl-more-inner"></div></div></div>
        </div>
      </article>`;
  }

  function render() {
    renderFilters();
    renderSuggestions();
    updateSummaryButton();
    const list = visibleItems();
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
    if (!it) return;
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
      .replace(/\[(\d+(?:\s*[,&]\s*\d+)*)\]/g, (m, nums) =>
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
  async function streamInto(el, endpoint, payload, button) {
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
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let queued = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (!queued) {
          queued = true;
          requestAnimationFrame(() => { queued = false; renderAi(el, text, sources); });
        }
      }
      renderAi(el, text.trim() || '⚠️ The model returned an empty reply. Try again.', sources);
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
    streamInto($('.ai-output', box), 'summary', { ids: items.slice(0, 20).map((i) => i.id), label }, $('#summaryBtn'));
  }

  // ---------- Ask sheet ----------
  function openSheet() {
    const sheet = $('#sheet');
    if (sheet.classList.contains('open')) return;
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    $('#backdrop').classList.add('show');
    document.body.classList.add('sheet-open');
  }

  function closeSheet() {
    $('#sheet').classList.remove('open');
    $('#sheet').setAttribute('aria-hidden', 'true');
    $('#backdrop').classList.remove('show');
    document.body.classList.remove('sheet-open');
    $('#askInput').blur();
  }

  function ask(question) {
    openSheet();
    const thread = $('#thread');
    const entry = document.createElement('div');
    entry.className = 'qa';
    entry.innerHTML = `<p class="q">${esc(question)}</p><div class="ai-output"></div>`;
    thread.append(entry);
    // Keep the thread short and focused.
    while (thread.children.length > 4) thread.firstElementChild.remove();
    entry.scrollIntoView({ behavior: 'smooth', block: 'end' });
    const ids = state.topic === 'all' ? [] : visibleItems().map((i) => i.id);
    streamInto($('.ai-output', entry), 'ask', { question, ids });
  }

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
      if ($('#settings').classList.contains('open')) return closeSettings();
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

  function openSettings(tab = state.tab) {
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
            <div><div class="model-name">${esc(r.label)} <span class="muted small">${esc(r.name)}</span></div><div class="muted small">${esc(r.note)}</div>
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

  // ---------- Boot ----------
  renderMasthead();
  const sk = $('#skeletonTpl');
  $('#timelineBody').append(...Array.from({ length: 6 }, () => sk.content.cloneNode(true)));

  loadFeed({ initial: true }).then(() => storage(VISIT_KEY, String(Date.now())));
  checkAi();
  setInterval(() => loadFeed(), REFRESH_MS);

  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
