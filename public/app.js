// Newsroll front-end: vertical news timeline + local AI (Ollama) features.
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
    scope: 'today',
    // The previous visit is captured once so "new" markers survive refreshes.
    prevVisit: Number(storage(VISIT_KEY)) || 0,
    pending: null,
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

  function dayLabel(t) {
    const today = startOfDay(Date.now());
    const day = startOfDay(t);
    if (day === today) return 'Today';
    if (day === today - 864e5) return 'Yesterday';
    return new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function relTime(t) {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 6 * 60) return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
    return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  const hourLabel = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' }).replace(':00', '');

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

  const visibleItems = () => (state.topic === 'all' ? state.items : state.items.filter((it) => it.topic === state.topic));

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
      $('#timelineBody').innerHTML = `<div class="empty">Couldn't load the feed: ${esc(err.message)}</div>`;
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
    $('span', pill).textContent = `${n} new ${n === 1 ? 'story' : 'stories'}`;
    pill.classList.remove('hidden');
  }

  function updateFooter(data) {
    $('#updated').textContent = `· updated ${new Date(data.fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    const parts = [];
    if (data.sample) parts.push('⚠️ Feeds unreachable — showing offline sample stories.');
    else parts.push(`${data.items.length} stories from ${(data.feeds || []).length - data.errors.length} feeds.`);
    if (data.errors.length && !data.sample) parts.push(`Failed: ${data.errors.map((e) => e.feed).join(', ')}.`);
    parts.push('Shortcuts: j / k to move, Enter to expand, / to ask.');
    $('#footNote').textContent = parts.join(' ');
  }

  // ---------- Rendering ----------
  const revealer = new IntersectionObserver(
    (entries) => {
      let i = 0;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.style.setProperty('--d', `${Math.min(i++, 8) * 45}ms`);
        e.target.classList.add('in');
        revealer.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -40px 0px' },
  );

  function renderFilters() {
    const counts = {};
    for (const it of state.items) counts[it.topic] = (counts[it.topic] || 0) + 1;
    const topics = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    if (state.topic !== 'all' && !counts[state.topic]) state.topic = 'all';
    $('#filters').innerHTML = [
      `<button class="filter ${state.topic === 'all' ? 'active' : ''}" data-topic="all">All <span class="n">${state.items.length}</span></button>`,
      ...topics.map(
        (t) => `<button class="filter ${state.topic === t ? 'active' : ''}" data-topic="${esc(t)}">${esc(t)} <span class="n">${counts[t]}</span></button>`,
      ),
    ].join('');
  }

  function itemHtml(it) {
    const t = ts(it);
    const fresh = state.prevVisit && t > state.prevVisit;
    return `
      <article class="tl-item${fresh ? ' fresh' : ''}" data-id="${it.id}" tabindex="-1">
        <span class="tl-dot"></span>
        <div class="tl-card" role="button" tabindex="0" aria-expanded="false">
          <div class="tl-meta">
            <time datetime="${esc(it.published)}">${relTime(t)}</time>·<span>${esc(it.source)}</span>·<span class="topic">${esc(it.topic)}</span>
            ${fresh ? '<span class="new-tag">New</span>' : ''}
          </div>
          <h4 class="tl-title">${esc(it.title)}</h4>
          <div class="tl-more"><div><div class="tl-more-inner"></div></div></div>
        </div>
      </article>`;
  }

  function render() {
    renderFilters();
    renderSuggestions();
    const list = visibleItems();
    const body = $('#timelineBody');
    if (!list.length) {
      body.innerHTML = '<div class="empty">No stories here yet.</div>';
      return;
    }

    let html = '';
    let curDay = null;
    let curHour = null;
    for (const it of list) {
      const t = ts(it);
      const day = startOfDay(t);
      if (day !== curDay) {
        curDay = day;
        curHour = null;
        const count = list.filter((x) => startOfDay(ts(x)) === day).length;
        html += `
          <div class="day" data-day="${day}">
            <h3>${esc(dayLabel(t))}<span class="muted">${count} ${count === 1 ? 'story' : 'stories'}</span></h3>
            <button class="btn ai-ghost sm day-sum"><span class="spark">✦</span> Summarize</button>
          </div>
          <div class="day-summary hidden" data-day-summary="${day}"><div class="ai-output"></div></div>`;
      }
      const hour = new Date(t).getHours();
      if (hour !== curHour) {
        curHour = hour;
        html += `<div class="hour">${esc(hourLabel(t))}</div>`;
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
          <button class="btn ai sm explain-btn"><span class="spark">✦</span> Explain this</button>
          ${it.link ? `<a class="btn sm" href="${esc(it.link)}" target="_blank" rel="noopener">Read full story ↗</a>` : ''}
          <span class="muted small">${new Date(ts(it)).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="tl-explain"></div>
        ${rel.length ? `<div class="related"><h4>Related on the timeline</h4>${rel.map((r) => `<button data-jump="${r.id}">${esc(r.title)} <span>· ${esc(r.source)}</span></button>`).join('')}</div>` : ''}`;
      inner.dataset.ready = '1';
    }
    el.classList.toggle('open', open);
    $('.tl-card', el).setAttribute('aria-expanded', String(open));
  }

  function jumpTo(id) {
    const it = state.byId.get(id);
    if (!it) return;
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
    render();
    if (state.scope === 'topic') updateBriefingTitle();
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
      if (line.startsWith('⚠️')) return { cls: 'warn', html: esc(line) };
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
      if (err.name !== 'AbortError') el.innerHTML = `<p class="warn">⚠️ ${esc(err.message)}</p>`;
    } finally {
      if (streams.get(el) === controller) {
        el.classList.remove('streaming');
        streams.delete(el);
      }
      if (button) button.disabled = false;
      setBusy(-1);
    }
  }

  // ---------- Briefing ----------
  function briefingSet() {
    const now = Date.now();
    if (state.scope === 'since') {
      const since = state.prevVisit || now - 12 * 3600e3;
      return { items: state.items.filter((i) => ts(i) > since), label: state.prevVisit ? `since ${relTime(state.prevVisit)}` : 'the last 12 hours' };
    }
    if (state.scope === 'topic') {
      if (state.topic === 'all') return { items: state.items, label: 'all topics' };
      return { items: visibleItems(), label: `${state.topic} news` };
    }
    let items = state.items.filter((i) => ts(i) >= startOfDay(now));
    if (items.length < 4) items = state.items.filter((i) => now - ts(i) < 24 * 3600e3);
    return { items, label: 'today' };
  }

  function updateBriefingTitle() {
    const { items, label } = briefingSet();
    const titles = { today: 'Your daily summary', since: 'Catch me up', topic: state.topic === 'all' ? 'Topic briefing' : `${state.topic} briefing` };
    $('#briefingTitle').textContent = titles[state.scope];
    $('#briefingMeta').textContent = `${items.length} ${items.length === 1 ? 'story' : 'stories'} · ${label}`;
  }

  function generateBriefing() {
    const { items, label } = briefingSet();
    const out = $('#briefingOut');
    if (!items.length) {
      out.innerHTML = '<p class="muted">Nothing new here yet — check back soon.</p>';
      return;
    }
    streamInto(out, 'summary', { ids: items.slice(0, 20).map((i) => i.id), label }, $('#briefingBtn'));
  }

  // ---------- AI status ----------
  let statusTimer;
  async function checkAi() {
    const pill = $('#aiStatus');
    const label = $('.ai-label', pill);
    try {
      const s = await (await fetch('/api/ai/status')).json();
      pill.classList.remove('ok', 'warn', 'off');
      if (s.online && s.installed) {
        pill.classList.add('ok');
        label.textContent = `${s.model} ready`;
        pill.title = `Local AI via Ollama at ${s.host}`;
      } else if (s.online) {
        pill.classList.add('warn');
        label.textContent = `Run: ollama pull ${s.model}`;
        pill.title = `Ollama is running but "${s.model}" isn't installed`;
      } else {
        pill.classList.add('off');
        label.textContent = 'AI offline';
        pill.title = `Start Ollama (ollama serve) at ${s.host}`;
      }
      clearTimeout(statusTimer);
      if (!(s.online && s.installed)) statusTimer = setTimeout(checkAi, 15000);
    } catch {
      label.textContent = 'AI unknown';
    }
  }

  function setBusy(delta) {
    activeStreams += delta;
    $('#aiStatus').classList.toggle('busy', activeStreams > 0);
  }

  // ---------- Scroll effects ----------
  let scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      const doc = document.documentElement;
      const max = doc.scrollHeight - innerHeight;
      document.body.style.setProperty('--p', max > 0 ? (scrollY / max).toFixed(4) : 0);
      // The timeline's coloured line "fills" as you read down through it.
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

    const explain = e.target.closest('.explain-btn');
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
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('#askInput').focus(); return; }
    if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (e.key === 'j') moveFocus(1);
    else if (e.key === 'k') moveFocus(-1);
    else if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.classList.contains('tl-card')) {
      e.preventDefault();
      toggleItem(document.activeElement.closest('.tl-item'));
    }
  });

  $$('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      state.scope = b.dataset.scope;
      updateBriefingTitle();
    }),
  );

  $('#briefingBtn').addEventListener('click', generateBriefing);

  $('#askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const question = $('#askInput').value.trim();
    if (!question) return;
    const out = $('#askOut');
    out.classList.remove('hidden');
    out.innerHTML = `<div class="q">${esc(question)}</div><div class="ai-output"></div>`;
    const ids = state.topic === 'all' ? [] : visibleItems().map((i) => i.id);
    streamInto($('.ai-output', out), 'ask', { question, ids }, $('#askForm button'));
  });

  $('#suggestions').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $('#askInput').value = chip.textContent;
    $('#askForm').requestSubmit();
  });

  $('#refreshBtn').addEventListener('click', () => loadFeed({ force: true }));
  $('#newPill').addEventListener('click', applyPending);
  $('#newPill').addEventListener('keydown', (e) => e.key === 'Enter' && applyPending());
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);

  // Keep relative timestamps fresh.
  setInterval(() => $$('.tl-item time').forEach((t) => (t.textContent = relTime(Date.parse(t.dateTime)))), 60000);

  // ---------- Boot ----------
  const sk = $('#skeletonTpl');
  $('#timelineBody').append(...Array.from({ length: 6 }, () => sk.content.cloneNode(true)));

  loadFeed({ initial: true }).then(() => {
    updateBriefingTitle();
    storage(VISIT_KEY, String(Date.now()));
  });
  checkAi();
  setInterval(() => loadFeed(), REFRESH_MS);
})();
