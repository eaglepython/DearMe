/* Dear Me Analytics dashboard. Vanilla JS, no build step. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : Number(n || 0).toLocaleString());
  const dur = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
  const flag = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '🌐');

  const shareToken = location.pathname.startsWith('/share/') ? location.pathname.split('/')[2] : null;
  const state = {
    sites: [], site: null, period: localGet('period') || '7d', metric: 'visitors', filters: {},
    tabs: { sources: 'sources', pages: 'pages', devices: 'browsers' }, data: null,
  };

  function localGet(k) { try { return localStorage.getItem('dm_' + k); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem('dm_' + k, v); } catch {} }

  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (res.status === 401 && !shareToken) { showLogin(); throw new Error('login'); }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw Object.assign(new Error(body.error || 'Request failed'), { status: res.status });
    return body;
  }

  // ------------------------------------------------------------ views
  function view(id) {
    for (const s of ['dash', 'sites', 'settings', 'empty']) $('#' + s).classList.toggle('hidden', s !== id);
    $('#settings-btn').classList.toggle('hidden', !!shareToken || !state.site || id === 'settings');
    $('#sites-btn').classList.toggle('hidden', !!shareToken);
    $('#period').classList.toggle('hidden', id !== 'dash');
    $('#live').classList.toggle('hidden', id !== 'dash');
  }
  function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#password').focus(); }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
      $('#login').classList.add('hidden');
      boot();
    } catch (err) { if (err.message !== 'login') $('#login-error').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/'; });

  // ------------------------------------------------------------ boot
  async function boot() {
    if (shareToken) {
      try {
        const me = await api(`/api/me?share=${encodeURIComponent(shareToken)}`);
        state.sites = me.sites;
      } catch { document.body.innerHTML = '<div class="center"><p class="muted">This dashboard is no longer shared.</p></div>'; return; }
    } else {
      try { await api('/api/me'); } catch { return; }
      state.sites = (await api('/api/sites')).sites;
    }
    $('#app').classList.remove('hidden');
    renderSiteSelect();
    const fromPath = location.pathname.match(/^\/site\/(\d+)/);
    const want = fromPath ? +fromPath[1] : +localGet('site');
    const site = state.sites.find((s) => s.id === want) || state.sites[0];
    if (!site) { view('empty'); return; }
    openSite(site.id, true);
  }

  function renderSiteSelect() {
    $('#site-select').innerHTML = state.sites.map((s) => `<option value="${s.id}">${esc(s.domain)}</option>`).join('');
    $('#site-select').classList.toggle('hidden', !state.sites.length);
    if (state.site) $('#site-select').value = state.site.id;
  }
  $('#site-select').addEventListener('change', (e) => openSite(+e.target.value));

  function openSite(id, replace) {
    state.site = state.sites.find((s) => s.id === id);
    state.filters = {};
    localSet('site', id);
    if (!shareToken) history[replace ? 'replaceState' : 'pushState'](null, '', `/site/${id}`);
    $('#site-select').value = id;
    $('#period').value = state.period;
    view('dash');
    load();
    connectLive();
  }

  $('#period').addEventListener('change', (e) => { state.period = e.target.value; localSet('period', state.period); load(); });
  $('#sites-btn').addEventListener('click', showSites);
  $('#empty-add').addEventListener('click', showSites);
  $('#settings-btn').addEventListener('click', showSettings);
  $('#settings-back').addEventListener('click', () => openSite(state.site.id));
  window.addEventListener('popstate', () => boot());

  // ------------------------------------------------------------ data
  function range() {
    const now = new Date();
    const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = 864e5;
    let from, to = now.getTime(), bucket = 'day';
    switch (state.period) {
      case 'today': from = sod(now).getTime(); bucket = 'hour'; break;
      case 'yesterday': to = sod(now).getTime(); from = to - day; bucket = 'hour'; break;
      case '30d': from = sod(now).getTime() - 29 * day; break;
      case 'month': from = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); break;
      case '90d': from = sod(now).getTime() - 89 * day; break;
      case '12mo': from = new Date(now.getFullYear() - 1, now.getMonth() + 1, 1).getTime(); bucket = 'month'; break;
      default: from = sod(now).getTime() - 6 * day;
    }
    return { from, to, bucket };
  }
  function query(extra = {}) {
    const { from, to, bucket } = range();
    const p = new URLSearchParams({ from, to, bucket, tz: -new Date().getTimezoneOffset(), ...state.filters, ...extra });
    // "Today" compares with the same hours yesterday, not the end of yesterday
    if (state.period === 'today') { p.set('pfrom', from - 864e5); p.set('pto', to - 864e5); }
    if (shareToken) p.set('share', shareToken); else p.set('site', state.site.id);
    return p.toString();
  }

  let loading = 0;
  async function load() {
    if (!state.site) return;
    const ticket = ++loading;
    const data = await api('/api/stats?' + query());
    if (ticket !== loading) return;
    state.data = data;
    render();
  }

  let es, refreshTimer;
  function connectLive() {
    es?.close();
    es = new EventSource('/api/live?' + query());
    es.onmessage = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (!$('#dash').classList.contains('hidden')) load(); }, 1500); };
  }
  setInterval(() => { if (!document.hidden && !$('#dash').classList.contains('hidden')) load(); }, 60000);

  // ------------------------------------------------------------ render
  const KPIS = [
    { key: 'visitors', label: 'Unique visitors', chart: true },
    { key: 'visits', label: 'Total visits' },
    { key: 'pageviews', label: 'Pageviews', chart: true },
    { key: 'viewsPerVisit', label: 'Views per visit' },
    { key: 'bounceRate', label: 'Bounce rate', fmt: (v) => v + '%', invert: true },
    { key: 'duration', label: 'Visit duration', fmt: dur },
  ];

  function render() {
    const d = state.data;
    $('#live span').textContent = d.realtime;

    $('#filters').innerHTML = Object.entries(state.filters).map(([k, v]) => `<button class="chip" data-k="${k}">${k[0].toUpperCase() + k.slice(1)} is <b>${esc(v)}</b> ✕</button>`).join('');
    $$('#filters .chip').forEach((c) => c.addEventListener('click', () => { delete state.filters[c.dataset.k]; load(); }));

    $('#kpis').innerHTML = KPIS.map((k) => {
      const cur = d.summary[k.key], prev = d.previous[k.key];
      let delta = '';
      if (prev) {
        const pct = Math.round(((cur - prev) / prev) * 100);
        const good = k.invert ? pct < 0 : pct > 0;
        delta = `<div class="delta ${pct === 0 ? 'flat' : good ? 'up' : 'down'}">${pct > 0 ? '↑' : pct < 0 ? '↓' : ''} ${Math.abs(pct)}%</div>`;
      } else delta = '<div class="delta flat">&nbsp;</div>';
      return `<button class="kpi ${state.metric === k.key ? 'active' : ''}" ${k.chart ? `data-metric="${k.key}"` : ''}>
        <div class="label">${k.label}</div><div class="value">${(k.fmt || num)(cur)}</div>${delta}</button>`;
    }).join('');
    $$('#kpis [data-metric]').forEach((b) => b.addEventListener('click', () => { state.metric = b.dataset.metric; render(); }));

    renderChart();
    renderPanel('sources', 'Top sources', [['sources', 'Sources', 'source'], ['campaigns', 'Campaigns', 'campaign']]);
    renderPanel('pages', 'Top pages', [['pages', 'Pages', 'page'], ['entry', 'Entry pages', 'page'], ['exit', 'Exit pages', 'page']]);
    renderPanel('countries', 'Countries', [['countries', 'Countries', 'country']]);
    renderPanel('devices', 'Devices', [['browsers', 'Browser', 'browser'], ['os', 'OS', 'os'], ['devices', 'Size', 'device']]);
    renderPanel('events', 'Goals and events', [['events', 'Goals', 'event']], 'Conversions');
  }

  function renderPanel(name, title, tabs, valueLabel = 'Visitors') {
    const el = $(`[data-panel="${name}"]`);
    const active = state.tabs[name] && tabs.find((t) => t[0] === state.tabs[name]) ? state.tabs[name] : tabs[0][0];
    const [key, , dim] = tabs.find((t) => t[0] === active);
    const rows = state.data[key] || [];
    const total = state.data.summary.visitors || 1;
    const max = Math.max(1, ...rows.map((r) => r.visitors));
    el.innerHTML = `
      <div class="ph"><h2>${title}</h2>${tabs.length > 1 ? `<div class="tabs">${tabs.map(([k, l]) => `<button data-t="${k}" class="${k === active ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}</div>
      ${rows.length ? `<div class="cols"><span>${tabs.find((t) => t[0] === active)[1]}</span><span>${valueLabel}</span></div>
      <div class="rows">${rows.map((r) => {
        const label = key === 'countries' ? `<span class="flag">${flag(r.key)}</span>${esc(r.key === '(none)' ? 'Unknown' : r.name || r.key)}` : esc(r.key === '(none)' ? 'Not set' : r.key);
        const pct = Math.round((r.visitors / total) * 100);
        return `<button class="r" data-dim="${dim}" data-val="${esc(r.key ?? '(none)')}" title="Filter by ${esc(r.key)}">
          <span class="fill" style="width:${(r.visitors / max) * 100}%"></span>
          <span class="k">${label}</span><span class="v">${num(r.visitors)}<small>${key === 'events' ? num(r.hits) + '×' : pct + '%'}</small></span></button>`;
      }).join('')}</div>` : `<div class="none">${name === 'events' ? 'No goals yet. See ⚙ settings to track signups or purchases.' : 'No data for this period yet'}</div>`}`;
    $$('.tabs button', el).forEach((b) => b.addEventListener('click', () => { state.tabs[name] = b.dataset.t; render(); }));
    $$('.r', el).forEach((b) => b.addEventListener('click', () => {
      if (state.filters[b.dataset.dim] === b.dataset.val) return;
      state.filters[b.dataset.dim] = b.dataset.val; load();
    }));
  }

  // ------------------------------------------------------------ chart
  function buckets() {
    const { from, to, bucket } = range();
    const out = [];
    const pad = (n) => String(n).padStart(2, '0');
    const key = (d) => bucket === 'month' ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
      : bucket === 'hour' ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const end = bucket === 'hour' ? Math.max(to, from + 864e5 - 1) : to;
    for (let d = new Date(from); d.getTime() < end; ) {
      out.push({ key: key(d), date: new Date(d) });
      if (bucket === 'hour') d.setHours(d.getHours() + 1);
      else if (bucket === 'month') d.setMonth(d.getMonth() + 1);
      else d.setDate(d.getDate() + 1);
    }
    return { out, bucket };
  }

  function renderChart() {
    const { out, bucket } = buckets();
    const byKey = Object.fromEntries(state.data.series.map((r) => [r.t, r]));
    const now = Date.now();
    const pts = out.map((b) => ({ ...b, v: byKey[b.key]?.[state.metric] || 0, future: b.date.getTime() > now }));
    const W = Math.max(300, $('#chart').clientWidth || 1000), H = W < 600 ? 200 : 260, L = 44, R = 20, T = 16, B = 30;
    const max = niceMax(Math.max(...pts.map((p) => p.v), 4));
    const x = (i) => L + (pts.length === 1 ? (W - L - R) / 2 : (i / (pts.length - 1)) * (W - L - R));
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const real = pts.filter((p) => !p.future);
    const line = real.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const area = real.length ? `${line} L${x(real.length - 1).toFixed(1)},${H - B} L${x(0).toFixed(1)},${H - B} Z` : '';
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${L}" x2="${W - R}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(max * f) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${max * f >= 10 ? num(Math.round(max * f)) : +(max * f).toFixed(1)}</text>`).join('');
    const step = Math.ceil(pts.length / Math.max(3, Math.floor(W / 120)));
    const label = (d) => bucket === 'hour' ? d.toLocaleTimeString([], { hour: 'numeric' }) : bucket === 'month' ? d.toLocaleDateString([], { month: 'short', year: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const xl = pts.map((p, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}" font-size="11" fill="var(--muted)">${label(p.date)}</text>` : '')).join('');
    $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${state.metric} over time">
      <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      ${grid}${xl}
      <path d="${area}" fill="url(#ga)"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <line id="hover-line" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 3" opacity="0"/>
      <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent" id="hover-zone"/>
    </svg>`;
    const svg = $('#chart svg'), tip = $('#tooltip'), hl = $('#hover-line');
    $('#hover-zone').addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const fx = ((e.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((fx - L) / (W - L - R)) * (pts.length - 1))));
      const p = pts[i];
      hl.setAttribute('x1', x(i)); hl.setAttribute('x2', x(i)); hl.setAttribute('opacity', 1);
      const when = bucket === 'hour' ? p.date.toLocaleString([], { weekday: 'short', hour: 'numeric' }) : bucket === 'month' ? p.date.toLocaleDateString([], { month: 'long', year: 'numeric' }) : p.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      tip.innerHTML = `${when}<br><b>${num(p.v)}</b> ${state.metric === 'visitors' ? 'visitors' : 'pageviews'}`;
      tip.style.left = `${(x(i) / W) * rect.width + 10}px`;
      tip.style.top = `${(y(p.v) / H) * rect.height + 14}px`;
      tip.classList.remove('hidden');
    });
    $('#hover-zone').addEventListener('mouseleave', () => { tip.classList.add('hidden'); hl.setAttribute('opacity', 0); });
  }
  let resizeT; window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => state.data && !$('#dash').classList.contains('hidden') && renderChart(), 150); });
  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 4, 5, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // ------------------------------------------------------------ sites
  async function showSites() {
    view('sites');
    history.pushState(null, '', '/');
    state.sites = (await api('/api/sites')).sites;
    renderSiteSelect();
    $('#site-list').innerHTML = state.sites.map((s) => `<div class="site-row" data-id="${s.id}">
      <span class="dot ${s.lastSeen && Date.now() - s.lastSeen < 864e5 ? 'on' : ''}"></span>
      <span class="d">${esc(s.domain)}</span>
      <span class="n">${num(s.visitors24h)} <span class="muted">visitors · 24h</span></span></div>`).join('') || '<p class="muted">No websites yet.</p>';
    $$('.site-row').forEach((r) => r.addEventListener('click', () => openSite(+r.dataset.id)));
    $('#new-domain').focus();
  }
  $('#add-site').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#add-error').textContent = '';
    try {
      const site = await api('/api/sites', { method: 'POST', body: JSON.stringify({ domain: $('#new-domain').value }) });
      $('#new-domain').value = '';
      state.sites = (await api('/api/sites')).sites;
      renderSiteSelect();
      state.site = state.sites.find((s) => s.id === site.id);
      showSettings();
    } catch (err) { $('#add-error').textContent = err.message; }
  });

  // ------------------------------------------------------------ settings
  function showSettings() {
    const s = state.site;
    view('settings');
    $('#site-select').value = s.id;
    $('#settings-title').textContent = s.domain;
    const tag = `<script defer data-domain="${s.domain}" src="${location.origin}/script.js"></script>`;
    $('#snippet').textContent = tag;
    $('#share-toggle').checked = !!s.share_token;
    renderShare();
  }
  function renderShare() {
    const t = state.site.share_token;
    $('#share-link').innerHTML = t ? `<a href="/share/${t}" target="_blank" rel="noopener">${location.origin}/share/${t}</a>` : '';
  }
  $('#copy-snippet').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#snippet').textContent); $('#copy-snippet').textContent = 'Copied ✓'; } catch { $('#copy-snippet').textContent = 'Select and copy above'; }
    setTimeout(() => { $('#copy-snippet').textContent = 'Copy snippet'; }, 2000);
  });
  $('#share-toggle').addEventListener('change', async (e) => {
    const r = await api(`/api/sites/${state.site.id}/share`, { method: 'POST', body: JSON.stringify({ on: e.target.checked }) });
    state.site.share_token = r.share_token;
    renderShare();
  });
  $('#export-btn').addEventListener('click', () => { location.href = '/api/export?' + query(); });
  let armed = false;
  $('#delete-btn').addEventListener('click', async () => {
    if (!armed) { armed = true; $('#delete-btn').textContent = `Click again to delete ${state.site.domain}`; setTimeout(() => { armed = false; $('#delete-btn').textContent = 'Delete site'; }, 4000); return; }
    await api(`/api/sites/${state.site.id}`, { method: 'DELETE' });
    armed = false; $('#delete-btn').textContent = 'Delete site';
    state.site = null;
    showSites();
  });

  boot();
})();
