/* Dear Me Analytics dashboard. Vanilla JS, no build step. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : Number(n || 0).toLocaleString());
  const dur = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
  const flag = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '🌐');
  const day = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

  const parts = location.pathname.split('/').filter(Boolean);
  const shareToken = parts[0] === 'share' ? parts[1] : null;
  const state = {
    sites: [], site: null, period: localGet('period') || '7d', metric: 'visitors', filters: {},
    tabs: { sources: 'sources', pages: 'pages', devices: 'browsers' }, data: null,
    me: null, config: {}, canManage: false, funnels: [], funnelId: null,
    tab: 'analyst', brief: null, askContext: null, history: [], turns: [],
  };

  function localGet(k) { try { return localStorage.getItem('dm_' + k); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem('dm_' + k, v); } catch {} }

  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (res.status === 401 && !shareToken && !path.startsWith('/api/login')) { showAuth('login'); throw new Error('login'); }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong'), { status: res.status });
    return body;
  }
  const post = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body || {}) });

  // ------------------------------------------------------------ views
  const VIEWS = ['analyst', 'dash', 'sites', 'settings', 'empty', 'team', 'account', 'admin'];
  function view(id) {
    for (const s of VIEWS) $('#' + s).classList.toggle('hidden', s !== id);
    const shared = !!shareToken;
    $('#settings-btn').classList.toggle('hidden', shared || !state.site || id === 'settings');
    for (const b of ['#sites-btn', '#account-btn']) $(b).classList.toggle('hidden', shared);
    $('#team-btn').classList.toggle('hidden', shared || !state.canManage);
    $('#admin-btn').classList.toggle('hidden', shared || !state.me?.operator);
    $('#period').classList.toggle('hidden', id !== 'dash');
    $('#live').classList.toggle('hidden', id !== 'dash');
    $('#site-select').classList.toggle('hidden', !state.sites.length || !['analyst', 'dash', 'settings'].includes(id));
    $('#site-tabs').classList.toggle('hidden', shared || !state.site || !['analyst', 'dash'].includes(id));
    $$('#site-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    $$('.manage-only').forEach((el) => el.classList.toggle('hidden', !state.canManage));
    window.scrollTo(0, 0);
  }
  function go(path) { if (location.pathname !== path) history.pushState(null, '', path); }

  // ------------------------------------------------------------ sign in / up / invite
  function showAuth(which) {
    $('#app').classList.add('hidden');
    $('#auth').classList.remove('hidden');
    for (const f of ['login', 'signup', 'invite']) $(`#${f}-form`).classList.toggle('hidden', f !== which);
    $('#to-signup-wrap').classList.toggle('hidden', !state.config.signup);
    if (which === 'login') { go('/login'); $('#login-email').focus(); }
    if (which === 'signup') { go('/signup'); $('#su-name').focus(); }
  }
  $('#to-signup').addEventListener('click', (e) => { e.preventDefault(); showAuth('signup'); });
  $('#to-login').addEventListener('click', (e) => { e.preventDefault(); showAuth('login'); });
  async function afterAuth() { $('#auth').classList.add('hidden'); go('/app'); boot(); }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try { await post('/api/login', { email: $('#login-email').value, password: $('#login-password').value }); afterAuth(); }
    catch (err) { $('#login-error').textContent = err.message; }
  });
  $('#signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#signup-error').textContent = '';
    try {
      await post('/api/signup', { name: $('#su-name').value, company: $('#su-company').value, email: $('#su-email').value, password: $('#su-password').value });
      afterAuth();
    } catch (err) { $('#signup-error').textContent = err.message; }
  });
  async function showInvite(token) {
    showAuth('invite');
    try {
      const inv = await api('/api/invite/' + encodeURIComponent(token));
      $('#invite-title').textContent = `Join ${inv.account}`;
      $('#invite-note').textContent = `You're joining as ${inv.role === 'admin' ? 'an admin' : 'a viewer'} with ${inv.email}.`;
    } catch (err) { $('#invite-note').textContent = err.message; $('#invite-form button').disabled = true; }
    $('#invite-form').onsubmit = async (e) => {
      e.preventDefault();
      $('#invite-error').textContent = '';
      try { await post('/api/invite/' + encodeURIComponent(token), { name: $('#inv-name').value, password: $('#inv-password').value }); afterAuth(); }
      catch (err) { $('#invite-error').textContent = err.message; }
    };
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    try { state.config = await api('/api/config'); } catch {}
    $('#trial-note').textContent = state.config.billing ? `${state.config.trialDays} days free. No card needed.` : 'Free to use.';
    const p = location.pathname.split('/').filter(Boolean);
    if (p[0] === 'invite' && p[1]) return showInvite(p[1]);
    if (shareToken) {
      try { state.sites = (await api(`/api/me?share=${encodeURIComponent(shareToken)}`)).sites; }
      catch { document.body.innerHTML = '<div class="center"><p class="muted">This dashboard is no longer shared.</p></div>'; return; }
    } else {
      const meRes = await fetch('/api/me', { credentials: 'same-origin' });
      if (!meRes.ok) return showAuth(p[0] === 'signup' && state.config.signup ? 'signup' : 'login');
      state.me = await meRes.json();
      const s = await api('/api/sites');
      state.sites = s.sites; state.canManage = s.canManage;
      renderBanner();
    }
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderSiteSelect();
    if (!shareToken && p[0] === 'team') return showTeam();
    if (!shareToken && p[0] === 'admin') return showAdmin();
    if (!shareToken && (p[0] === 'account' || new URLSearchParams(location.search).get('billing'))) return showAccount();
    const want = p[0] === 'site' ? +p[1] : +localGet('site');
    const site = state.sites.find((x) => x.id === want) || state.sites[0];
    if (!site) { view('empty'); $('#empty-add').classList.toggle('hidden', !state.canManage); return; }
    openSite(site.id, true, p[0] === 'site' && p[2] === 'dashboard' ? 'dash' : p[0] === 'site' ? 'analyst' : localGet('tab') || 'analyst');
  }

  function renderBanner() {
    const a = state.me?.account, el = $('#banner');
    if (!a || !state.config.billing || a.plan === 'operator') return el.classList.add('hidden');
    let html = '';
    const days = a.trialEnds ? Math.max(0, Math.ceil((a.trialEnds - Date.now()) / 864e5)) : null;
    if (a.state === 'expired') html = '<b>Your free trial has ended.</b> Pick a plan to keep counting visitors.';
    else if (a.state === 'over_limit') html = `<b>You've used ${num(a.usage)} of ${num(a.limit)} pageviews this month.</b> Upgrade so nothing gets dropped.`;
    else if (a.plan === 'trial') html = `Free trial: <b>${days} day${days === 1 ? '' : 's'} left</b>. ${num(a.usage)} pageviews used this month.`;
    if (!html) return el.classList.add('hidden');
    el.innerHTML = `<span>${html}</span>${state.me.user.role === 'owner' ? '<button class="btn small-btn" id="banner-upgrade">See plans</button>' : ''}`;
    el.className = 'banner' + (a.state === 'expired' || a.state === 'over_limit' ? ' warn' : '');
    $('#banner-upgrade')?.addEventListener('click', showAccount);
  }

  function renderSiteSelect() {
    $('#site-select').innerHTML = state.sites.map((s) => `<option value="${s.id}">${esc(s.domain)}</option>`).join('');
    if (state.site) $('#site-select').value = state.site.id;
  }
  $('#site-select').addEventListener('change', (e) => openSite(+e.target.value, false, state.tab));
  $$('#site-tabs button').forEach((b) => b.addEventListener('click', () => openSite(state.site.id, false, b.dataset.tab)));

  function openSite(id, replace, tab = state.tab) {
    const changed = state.site?.id !== id;
    state.site = state.sites.find((s) => s.id === id);
    if (changed) { state.filters = {}; state.funnelId = null; state.turns = []; state.history = []; state.askContext = null; $('#thread').innerHTML = ''; }
    state.tab = shareToken ? 'dash' : tab === 'dash' ? 'dash' : 'analyst';
    localSet('site', id); localSet('tab', state.tab);
    if (!shareToken) history[replace ? 'replaceState' : 'pushState'](null, '', state.tab === 'dash' ? `/site/${id}/dashboard` : `/site/${id}`);
    $('#site-select').value = id;
    $('#period').value = state.period;
    view(state.tab);
    if (state.tab === 'analyst') return showAnalyst();
    load();
    loadInsights();
    connectLive();
  }

  $('#period').addEventListener('change', (e) => { state.period = e.target.value; localSet('period', state.period); load(); });
  $('#sites-btn').addEventListener('click', showSites);
  $('#empty-add').addEventListener('click', showSites);
  $('#settings-btn').addEventListener('click', showSettings);
  $('#team-btn').addEventListener('click', showTeam);
  $('#account-btn').addEventListener('click', showAccount);
  $('#admin-btn').addEventListener('click', showAdmin);
  $('#settings-back').addEventListener('click', () => openSite(state.site.id, false, state.tab));
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
    loadFunnels();
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
    $('#imported-note').classList.toggle('hidden', !d.imported);

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
        const pct = Math.min(100, Math.round((r.visitors / total) * 100));
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


  // ------------------------------------------------------------ insights
  async function loadInsights() {
    const el = $('#insights');
    const siteId = state.site.id;
    el.classList.remove('hidden');
    el.innerHTML = '<div class="ph"><h2>✦ This week, in plain English</h2></div><p class="muted small">Reading your numbers…</p>';
    try {
      const q = shareToken ? `share=${encodeURIComponent(shareToken)}` : `site=${siteId}`;
      const r = await api('/api/insights?' + q);
      if (state.site.id !== siteId) return;
      el.innerHTML = `<div class="ph"><h2>✦ This week, in plain English</h2>${r.summary ? '<span class="pill">AI summary</span>' : ''}</div>
        ${r.summary ? `<p class="ai">${esc(r.summary)}</p>` : ''}
        <ul class="bullets">${r.bullets.map((b) => `<li class="${b.tone}">${esc(b.text)}</li>`).join('')}</ul>
        ${!r.ai && state.me?.operator ? '<p class="muted small">Tip: set ANTHROPIC_API_KEY on the server to add an AI-written summary with advice.</p>' : ''}`;
    } catch { el.classList.add('hidden'); }
  }

  // ------------------------------------------------------------ funnels
  async function loadFunnels() {
    const el = $('#funnels');
    if (shareToken) { el.classList.add('hidden'); return; }
    try { state.funnels = (await api(`/api/sites/${state.site.id}/funnels`)).funnels; } catch { state.funnels = []; }
    if (!state.funnels.find((f) => f.id === state.funnelId)) state.funnelId = state.funnels[0]?.id || null;
    const head = `<div class="ph"><h2>Funnels</h2><div class="row gap">
        ${state.funnels.length ? `<select id="funnel-select">${state.funnels.map((f) => `<option value="${f.id}" ${f.id === state.funnelId ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>` : ''}
        ${state.canManage ? '<button class="btn small-btn" id="funnel-new">+ New funnel</button>' : ''}</div></div>`;
    if (!state.funnelId) {
      el.innerHTML = head + `<div class="none">See where visitors drop off on the way to a signup or purchase.${state.canManage ? '<br>Click <b>+ New funnel</b> to set one up, for example Home → Pricing → Signup.' : ''}</div>`;
    } else {
      const { from, to } = range();
      const f = await api(`/api/funnel?site=${state.site.id}&id=${state.funnelId}&from=${from}&to=${to}`);
      const max = Math.max(1, f.steps[0].visits);
      const last = f.steps.at(-1);
      el.innerHTML = head + `<p class="muted small">${num(f.steps[0].visits)} visits started this funnel; <b>${last.conversion}%</b> made it to the end.</p>
        <div class="funnel">${f.steps.map((s, i) => `
          <div class="fstep">
            <div class="fbar"><i style="height:${Math.max(2, (s.visits / max) * 100)}%"></i></div>
            <div class="fnum">${num(s.visits)}</div>
            <div class="fpct">${s.conversion}%</div>
            <div class="flabel">${i + 1}. ${s.type === 'event' ? '⚑ ' : ''}${esc(s.value)}</div>
            ${i ? `<div class="fdrop">−${num(s.dropoff)} dropped (${s.dropoffRate}%)</div>` : '<div class="fdrop">&nbsp;</div>'}
          </div>`).join('')}</div>
        ${state.canManage ? '<button class="link small" id="funnel-del">Delete this funnel</button>' : ''}`;
    }
    $('#funnel-select')?.addEventListener('change', (e) => { state.funnelId = +e.target.value; loadFunnels(); });
    $('#funnel-new')?.addEventListener('click', funnelForm);
    $('#funnel-del')?.addEventListener('click', async () => {
      await api(`/api/sites/${state.site.id}/funnels/${state.funnelId}`, { method: 'DELETE' });
      state.funnelId = null; loadFunnels();
    });
  }
  function funnelForm() {
    const el = $('#funnels');
    const pages = (state.data?.pages || []).map((p) => p.key);
    const goals = (state.data?.events || []).map((g) => g.key);
    const stepRow = (type = 'page', value = '') => `<div class="row gap fs-row">
        <select class="fs-type"><option value="page" ${type === 'page' ? 'selected' : ''}>Visits page</option><option value="event" ${type === 'event' ? 'selected' : ''}>Completes goal</option></select>
        <input class="fs-value" list="${type === 'event' ? 'dl-goals' : 'dl-pages'}" value="${esc(value)}" placeholder="${type === 'event' ? 'Signup' : '/pricing  (use * for any, like /blog/*)'}">
        <button type="button" class="icon-btn fs-del" aria-label="Remove step">✕</button></div>`;
    el.innerHTML = `<div class="ph"><h2>New funnel</h2></div>
      <datalist id="dl-pages">${pages.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <datalist id="dl-goals">${goals.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
      <input id="fn-name" placeholder="Name, e.g. Signup flow">
      <div id="fn-steps">${stepRow('page', '/')}${stepRow('page', pages.find((p) => p !== '/') || '/pricing')}${goals[0] ? stepRow('event', goals[0]) : ''}</div>
      <div class="row gap wrap"><button type="button" class="btn ghost" id="fn-add">+ Add step</button><div class="grow"></div>
        <button type="button" class="btn ghost" id="fn-cancel">Cancel</button><button type="button" class="btn primary" id="fn-save">Save funnel</button></div>
      <p class="error" id="fn-error"></p>`;
    const bind = () => {
      $$('.fs-del', el).forEach((b) => (b.onclick = () => { if ($$('.fs-row', el).length > 2) b.closest('.fs-row').remove(); }));
      $$('.fs-type', el).forEach((s) => (s.onchange = () => { const i = s.nextElementSibling; i.setAttribute('list', s.value === 'event' ? 'dl-goals' : 'dl-pages'); i.placeholder = s.value === 'event' ? 'Signup' : '/pricing'; }));
    };
    bind();
    $('#fn-add').onclick = () => { if ($$('.fs-row', el).length < 8) { $('#fn-steps').insertAdjacentHTML('beforeend', stepRow()); bind(); } };
    $('#fn-cancel').onclick = loadFunnels;
    $('#fn-save').onclick = async () => {
      const steps = $$('.fs-row', el).map((r) => ({ type: $('.fs-type', r).value, value: $('.fs-value', r).value.trim() }));
      try {
        const r = await post(`/api/sites/${state.site.id}/funnels`, { name: $('#fn-name').value, steps });
        state.funnelId = r.id; loadFunnels();
      } catch (err) { $('#fn-error').textContent = err.message; }
    };
  }

  // ------------------------------------------------------------ the analyst
  const tz = () => -new Date().getTimezoneOffset();
  const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

  async function showAnalyst() {
    const site = state.site;
    $('#ask-domain').textContent = site.domain;
    $('#ask-input').value = '';
    renderThread();
    $('#biz-kpis').innerHTML = '';
    $('#steps-panel').innerHTML = '<div class="ph"><h2>Next steps</h2></div><p class="muted small">Looking at your numbers…</p>';
    $('#alerts-panel').innerHTML = '<div class="ph"><h2>Alerts</h2></div>';
    $('#sources-panel').innerHTML = '';
    let b;
    try { b = await api(`/api/sites/${site.id}/brief?tz=${tz()}`); } catch { return; }
    if (state.site.id !== site.id) return;
    state.brief = b;
    renderSuggest();
    $('#biz-kpis').innerHTML = b.kpis.map((k) => {
      const good = k.change == null || k.change === 0 ? 'flat' : (k.change > 0) !== k.lowerIsBetter ? 'up' : 'down';
      return `<button class="kpi" data-q="${esc(`How did my ${k.label} change this week?`)}"><div class="label">${esc(k.label[0].toUpperCase() + k.label.slice(1))} · 7 days</div><div class="value">${esc(k.display)}</div>
        <div class="delta ${good}">${k.change == null ? '&nbsp;' : `${k.change > 0 ? '↑' : k.change < 0 ? '↓' : ''} ${Math.abs(k.change)}%`}</div></button>`;
    }).join('');
    $$('#biz-kpis [data-q]').forEach((el) => el.addEventListener('click', () => askQ(el.dataset.q)));
    renderSteps(b.nextSteps);
    renderAlerts(b.alerts);
    renderSources(b.connected);
  }
  function renderSuggest() {
    const b = state.brief; if (!b) return;
    const recent = (b.recent || []).filter((q) => !b.suggestions.includes(q)).slice(0, 2);
    $('#ask-suggest').innerHTML = [...b.suggestions, ...recent].map((q) => `<button class="chip ghosty" data-q="${esc(q)}">${esc(q)}</button>`).join('');
    $$('#ask-suggest [data-q]').forEach((el) => el.addEventListener('click', () => askQ(el.dataset.q)));
  }
  function renderSteps(steps) {
    $('#steps-panel').innerHTML = `<div class="ph"><h2>Next steps</h2><span class="muted small">last 30 days</span></div>` + (steps.length ? `<ol class="steps">${steps.map((r, i) => `
      <li class="step ${r.tone}"><div class="st">${esc(r.title)}</div><div class="sw">${esc(r.why)}</div>${r.action ? `<div class="sa">→ ${esc(r.action)}</div>` : ''}
        ${r.ask ? `<button class="link small" data-q="${esc(r.ask)}">Ask: ${esc(r.ask)}</button>` : r.setup && state.canManage ? `<button class="link small" data-setup="1">Set it up</button>` : ''}</li>`).join('')}</ol>`
      : '<p class="muted small">Nothing urgent. I will suggest next steps as data comes in.</p>');
    $$('#steps-panel [data-q]').forEach((el) => el.addEventListener('click', () => askQ(el.dataset.q)));
    $$('#steps-panel [data-setup]').forEach((el) => el.addEventListener('click', () => { showSettings(); $('#data-panel').scrollIntoView({ behavior: 'smooth' }); }));
  }
  function renderAlerts(list) {
    const unseen = list.filter((a) => !a.seen).length;
    $('#alerts-panel').innerHTML = `<div class="ph"><h2>Alerts</h2>${unseen ? `<span class="pill">${unseen} new</span>` : ''}</div>` + (list.length ? `<div class="alerts">${list.slice(0, 6).map((a) => `
      <div class="alert ${a.severity} ${a.seen ? '' : 'new'}"><i></i><div><div class="at">${esc(a.title)}</div><div class="ab">${esc(a.body || '')}</div><div class="muted small">${ago(a.created)}</div></div></div>`).join('')}</div>`
      : '<p class="muted small">All quiet. I check every hour for drops, spikes, tracking problems and ads that stop paying off.</p>');
    if (unseen) setTimeout(() => post(`/api/sites/${state.site.id}/alerts/seen`).catch(() => {}), 4000);
  }
  function renderSources(c) {
    const tile = (on, name, yes, no, setup) => `<div class="src ${on ? 'on' : ''}"><div class="sn">${on ? '✓' : '○'} ${name}</div><div class="muted small">${on ? yes : no}</div>
      ${!on && setup && state.canManage ? '<button class="link small" data-setup="1">Connect</button>' : ''}</div>`;
    $('#sources-panel').innerHTML = `<div class="ph"><h2>What I can see</h2><span class="muted small">${state.brief.ai ? 'AI answers on' : 'Instant answers'}</span></div><div class="srcs">
      ${tile(c.website, 'Website', 'Visitors, pages, sources', 'Add the snippet to your site', true)}
      ${tile(c.goals, 'Goals', 'Signups, purchases, downloads', 'Track signups or purchases', true)}
      ${tile(c.sales, 'Sales', 'Revenue by source and page', 'Connect Stripe, Shopify or a CSV', true)}
      ${tile(c.ads, 'Ad costs', 'Which ads pay for themselves', 'Upload a cost report', true)}</div>`;
    $$('#sources-panel [data-setup]').forEach((el) => el.addEventListener('click', () => { showSettings(); (c.website ? $('#data-panel') : $('#snippet')).scrollIntoView({ behavior: 'smooth' }); }));
  }

  $('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); askQ($('#ask-input').value); });
  async function askQ(question) {
    question = String(question || '').trim();
    if (!question || !state.site) return;
    $('#ask-input').value = '';
    const turn = { q: question, pending: true };
    state.turns.unshift(turn);
    renderThread();
    window.scrollTo({ top: $('#thread').offsetTop - 80, behavior: 'smooth' });
    try {
      const r = await post(`/api/sites/${state.site.id}/ask`, { question, tz: tz(), context: state.askContext, history: state.history.slice(-3) });
      Object.assign(turn, r, { pending: false });
      if (r.spec) state.askContext = r.spec;
      state.history.push({ q: question, a: r.answer });
    } catch (err) { Object.assign(turn, { pending: false, answer: err.message === 'login' ? '' : `Sorry, something went wrong: ${err.message}`, error: true }); }
    renderThread();
  }
  function renderThread() {
    $('#thread').innerHTML = state.turns.slice(0, 12).map((t, i) => `<div class="turn ${t.pending ? 'fresh' : ''}">
      <div class="q">${esc(t.q)}</div>
      <div class="a panel">${t.pending ? '<div class="thinking"><i></i><i></i><i></i> <span class="muted">Looking at your numbers…</span></div>' : `
        <p class="a-text">${esc(t.answer)}</p>
        ${t.highlights?.length ? `<div class="hl">${t.highlights.map((h) => `<div class="h ${h.tone || ''}"><div class="hv">${esc(h.value)}</div><div class="hk">${esc(h.label)}${h.sub ? ` <b>${esc(h.sub)}</b>` : ''}</div></div>`).join('')}</div>` : ''}
        ${t.evidence ? evidence(t.evidence, i) : ''}
        ${t.drivers?.length ? `<div class="drivers">${t.drivers.map((d) => `<div class="drv"><span class="muted small">${esc(d.dim)}</span> <b>${esc(d.label)}</b> <span class="${d.delta > 0 ? 'up' : 'down'}">${d.delta > 0 ? '+' : '−'}${num(Math.abs(Math.round(d.delta * 100) / 100))}</span> <span class="muted small">(${num(d.before)} → ${num(d.now)})</span></div>`).join('')}</div>` : ''}
        ${t.nextSteps?.length && t.intent !== 'overview' ? `<ol class="steps compact">${t.nextSteps.slice(0, 4).map((r) => `<li class="step ${r.tone || ''}"><div class="st">${esc(r.title)}</div><div class="sw">${esc(r.why)}</div>${r.action ? `<div class="sa">→ ${esc(r.action)}</div>` : ''}</li>`).join('')}</ol>` : ''}
        ${t.setup && state.canManage ? '<button class="btn small-btn" data-setup="1">Connect it now</button>' : ''}
        ${t.followUps?.length ? `<div class="fu">${t.followUps.map((f) => `<button class="chip ghosty" data-q="${esc(f)}">${esc(f)}</button>`).join('')}</div>` : ''}
        ${t.error ? '' : `<div class="a-meta">${t.ai ? '✦ Written by AI from your numbers' : 'Answered from your numbers'}</div>`}`}
      </div></div>`).join('');
    $$('#thread [data-q]').forEach((el) => el.addEventListener('click', () => askQ(el.dataset.q)));
    $$('#thread [data-setup]').forEach((el) => el.addEventListener('click', () => { showSettings(); $('#data-panel').scrollIntoView({ behavior: 'smooth' }); }));
  }
  function evidence(ev, i) {
    const rows = ev.rows.filter((r) => r.value != null);
    if (!rows.length) return '';
    if (ev.series && rows.length > 2) {
      const W = 640, H = 150, L = 6, R = 6, T = 12, B = 22;
      const max = Math.max(...rows.map((r) => r.value), 1), min = Math.min(0, ...rows.map((r) => r.value));
      const x = (j) => L + (j / (rows.length - 1)) * (W - L - R), y = (v) => T + (1 - (v - min) / (max - min || 1)) * (H - T - B);
      const line = rows.map((r, j) => `${j ? 'L' : 'M'}${x(j).toFixed(1)},${y(r.value).toFixed(1)}`).join(' ');
      const peak = rows.reduce((a, r, j) => (r.value > rows[a].value ? j : a), 0);
      return `<figure class="ev"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(ev.metricLabel)} by ${esc(ev.byLabel)}">
          <defs><linearGradient id="eg${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".25"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
          <path d="${line} L${x(rows.length - 1)},${H - B} L${x(0)},${H - B} Z" fill="url(#eg${i})"/>
          <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
          <circle cx="${x(peak)}" cy="${y(rows[peak].value)}" r="3.5" fill="var(--accent)" vector-effect="non-scaling-stroke"/></svg>
        <figcaption><span>${esc(rows[0].label)}</span><span>Peak ${esc(rows[peak].display)} · ${esc(rows[peak].label)}</span><span>${esc(rows.at(-1).label)}</span></figcaption></figure>`;
    }
    const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
    return `<div class="ev bars">${rows.slice(0, 8).map((r) => {
      const d = r.previous != null && r.previous !== undefined && typeof r.value === 'number' ? r.value - r.previous : null;
      return `<div class="bar"><span class="fill" style="width:${Math.max(1, (Math.abs(r.value) / max) * 100)}%"></span><span class="k">${esc(r.label)}</span>
        <span class="v">${esc(r.display)}${d != null && r.previous ? ` <small class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '↑' : d < 0 ? '↓' : ''}${d ? Math.abs(Math.round((d / Math.abs(r.previous)) * 100)) + '%' : ''}</small>` : ''}</span></div>`;
    }).join('')}</div>`;
  }

  // ------------------------------------------------------------ connected sales and ads (settings)
  const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'INR', 'BRL', 'MXN', 'ZAR', 'NGN', 'KES', 'GHS', 'XOF', 'XAF', 'MAD', 'SEK', 'NOK', 'DKK', 'PLN', 'SGD', 'NZD', 'AED'];
  $('#data-currency').innerHTML = CURRENCIES.map((c) => `<option>${c}</option>`).join('');
  async function loadData() {
    const d = await api(`/api/sites/${state.site.id}/data`);
    $('#hook-url').value = d.webhook;
    if (!CURRENCIES.includes(d.currency)) $('#data-currency').insertAdjacentHTML('beforeend', `<option>${esc(d.currency)}</option>`);
    $('#data-currency').value = d.currency;
    const money = (v) => { try { return new Intl.NumberFormat([], { style: 'currency', currency: d.currency, maximumFractionDigits: 0 }).format(v); } catch { return `${d.currency} ${num(Math.round(v))}`; } };
    $('#data-summary').innerHTML = `<div class="ds ${d.sales.orders ? 'on' : ''}"><b>${d.sales.orders ? '✓' : '○'} Sales</b> ${d.sales.orders ? `${num(d.sales.orders)} orders, ${money(d.sales.revenue)} since ${day(d.sales.first)} · 
        ${[d.sales.viaTracker && `${num(d.sales.viaTracker)} from your site`, d.sales.viaWebhook && `${num(d.sales.viaWebhook)} from your shop`, d.sales.viaCsv && `${num(d.sales.viaCsv)} uploaded`].filter(Boolean).join(' · ')}
        <button class="link small danger-text" data-clear="sales">Remove all</button>` : '<span class="muted">not connected yet</span>'}</div>
      <div class="ds ${d.ads.length ? 'on' : ''}"><b>${d.ads.length ? '✓' : '○'} Ad costs</b> ${d.ads.length ? d.ads.map((a) => `${esc(a.channel)} ${money(a.spend)} (${esc(a.first)} to ${esc(a.last)})`).join(' · ') + ' <button class="link small danger-text" data-clear="ads">Remove all</button>' : '<span class="muted">none yet</span>'}</div>`;
    $$('#data-summary [data-clear]').forEach((b) => (b.onclick = async () => {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Click again to remove'; return; }
      await api(`/api/sites/${state.site.id}/data/${b.dataset.clear}`, { method: 'DELETE' }); loadData();
    }));
  }
  const DATA_HINTS = { sales: 'An orders export with a date and an amount (Shopify, WooCommerce, Stripe payments, or your own spreadsheet). A source or utm_source column lets me match sales to channels.', ads: 'A report by day with cost and campaign columns. Google Ads: Campaigns → Download, segmented by Day. Meta: Ads Manager → Reports → Export, broken down by Day.' };
  const setKind = () => { const k = $('#data-kind').value; $('#data-channel').classList.toggle('hidden', k !== 'ads'); $('#data-hint').textContent = DATA_HINTS[k]; };
  $('#data-kind').addEventListener('change', setKind); setKind();
  $('#data-file').addEventListener('change', async (e) => {
    const msgs = [];
    for (const f of [...e.target.files]) {
      try {
        const r = await post(`/api/sites/${state.site.id}/data`, { kind: $('#data-kind').value, channel: $('#data-channel').value, filename: f.name, csv: await f.text() });
        msgs.push(r.kind === 'ads' ? `✓ ${f.name}: ${r.rows} days of ${r.channels.join(', ')} costs (${r.from} to ${r.to})` : `✓ ${f.name}: ${r.rows} orders (${r.from} to ${r.to})`);
      } catch (err) { msgs.push(`✕ ${f.name}: ${err.message}`); }
    }
    e.target.value = '';
    $('#data-msg').innerHTML = msgs.map(esc).join('<br>');
    loadData();
  });
  $('#data-currency').addEventListener('change', async (e) => { try { await post(`/api/sites/${state.site.id}/data`, { currency: e.target.value }, 'PUT'); state.site.currency = e.target.value; loadData(); } catch (err) { $('#data-msg').textContent = err.message; } });
  $('#hook-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#hook-url').value); $('#hook-copy').textContent = 'Copied ✓'; } catch { $('#hook-url').select(); } setTimeout(() => { $('#hook-copy').textContent = 'Copy'; }, 2000); });
  $('#hook-rotate').addEventListener('click', async () => {
    const b = $('#hook-rotate');
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Click again: anything using the old address will stop sending'; return; }
    b.dataset.armed = ''; b.textContent = 'Make a new address (the old one stops working)';
    $('#hook-url').value = (await post(`/api/sites/${state.site.id}/data/key`)).webhook;
  });

  // ------------------------------------------------------------ sites
  async function showSites() {
    view('sites');
    go('/app/sites');
    const s = await api('/api/sites');
    state.sites = s.sites; state.canManage = s.canManage;
    renderSiteSelect();
    $('#add-site').classList.toggle('hidden', !state.canManage);
    const lim = state.me?.account?.siteLimit;
    $('#site-list').innerHTML = (state.sites.map((x) => `<div class="site-row" data-id="${x.id}">
      <span class="dot ${x.lastSeen && Date.now() - x.lastSeen < 864e5 ? 'on' : ''}"></span>
      <span class="d">${esc(x.domain)}</span>
      <span class="n">${num(x.visitors24h)} <span class="muted">visitors · 24h</span></span></div>`).join('') || '<p class="muted">No websites yet.</p>')
      + (lim ? `<p class="muted small">${state.sites.length} of ${lim} websites on your plan.</p>` : '');
    $$('.site-row').forEach((r) => r.addEventListener('click', () => openSite(+r.dataset.id)));
  }
  $('#add-site').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#add-error').textContent = '';
    try {
      const site = await post('/api/sites', { domain: $('#new-domain').value });
      $('#new-domain').value = '';
      state.sites = (await api('/api/sites')).sites;
      renderSiteSelect();
      state.site = state.sites.find((x) => x.id === site.id);
      showSettings();
    } catch (err) { $('#add-error').innerHTML = esc(err.message) + (err.status === 402 ? ' <a href="#" id="add-upgrade">See plans</a>' : ''); $('#add-upgrade')?.addEventListener('click', (ev) => { ev.preventDefault(); showAccount(); }); }
  });

  // ------------------------------------------------------------ settings
  function showSettings() {
    const s = state.site;
    view('settings');
    $('#site-select').value = s.id;
    $('#settings-title').textContent = s.domain;
    $('#snippet').textContent = `<script defer data-domain="${s.domain}" src="${location.origin}/script.js"></script>`;
    $('#share-toggle').checked = !!s.share_token;
    $('#report-emails').value = (s.report_emails || '').split(',').filter(Boolean).join(', ');
    $('#report-preview').href = `/api/sites/${s.id}/report/preview`;
    $('#report-send').classList.toggle('hidden', !state.config.email);
    $('#report-msg').textContent = state.config.email ? '' : 'Email sending is not set up on this server yet (RESEND_API_KEY). You can still preview the report.';
    $('#import-msg').textContent = '';
    renderShare();
    if (state.canManage) { loadImports(); loadData(); }
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
    const r = await post(`/api/sites/${state.site.id}/share`, { on: e.target.checked });
    state.site.share_token = r.share_token;
    renderShare();
  });
  $('#report-save').addEventListener('click', async () => {
    try {
      const r = await post(`/api/sites/${state.site.id}/report`, { emails: $('#report-emails').value }, 'PUT');
      state.site.report_emails = r.emails.join(',');
      $('#report-msg').textContent = r.emails.length ? `Saved. ${r.emails.length} ${r.emails.length === 1 ? 'person gets' : 'people get'} the report every Monday.` : 'Saved. Nobody gets the weekly report.';
    } catch (err) { $('#report-msg').textContent = err.message; }
  });
  $('#report-send').addEventListener('click', async () => {
    $('#report-msg').textContent = 'Sending…';
    try { const r = await post(`/api/sites/${state.site.id}/report/send`); $('#report-msg').textContent = `Sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.`; }
    catch (err) { $('#report-msg').textContent = err.message; }
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

  // Google Analytics import
  const DIM_NAMES = { date: 'Visitors by day', page: 'Pages', source: 'Traffic sources', country: 'Countries', browser: 'Browsers', os: 'Operating systems', device: 'Devices', event: 'Events' };
  async function loadImports() {
    const { imports } = await api(`/api/sites/${state.site.id}/imports`);
    $('#import-list').innerHTML = imports.map((i) => `<div class="imp-row"><span><b>${DIM_NAMES[i.dim] || i.dim}</b> · ${esc(i.start_day)} to ${esc(i.end_day)} · ${num(i.rows)} rows <span class="muted small">(${esc(i.filename)})</span></span>
      <button class="link small" data-id="${i.id}">Remove</button></div>`).join('');
    $$('#import-list [data-id]').forEach((b) => (b.onclick = async () => { await api(`/api/sites/${state.site.id}/imports/${b.dataset.id}`, { method: 'DELETE' }); loadImports(); }));
  }
  async function importFiles(files) {
    const msgs = [];
    for (const f of files) {
      try {
        const r = await post(`/api/sites/${state.site.id}/imports`, { filename: f.name, csv: await f.text() });
        msgs.push(`✓ ${f.name}: ${DIM_NAMES[r.dim]}, ${r.start} to ${r.end}, ${r.rows} rows`);
      } catch (err) { msgs.push(`✕ ${f.name}: ${err.message}`); }
    }
    $('#import-msg').innerHTML = msgs.map(esc).join('<br>');
    loadImports();
  }
  $('#import-file').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); importFiles([...e.dataTransfer.files]); });

  // ------------------------------------------------------------ team
  async function showTeam() {
    view('team');
    go('/team');
    const t = await api('/api/team');
    const myId = state.me.user.id, iAmOwner = state.me.user.role === 'owner';
    $('#team-list').innerHTML = `<h2>People</h2>` + t.users.map((u) => `<div class="member">
        <div><b>${esc(u.name || u.email)}</b>${u.id === myId ? ' <span class="muted small">(you)</span>' : ''}<div class="muted small">${esc(u.email)}</div></div>
        <select data-role="${u.id}" ${u.id === myId || (u.role === 'owner' && !iAmOwner) ? 'disabled' : ''}>
          ${['owner', 'admin', 'viewer'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''} ${r === 'owner' && !iAmOwner ? 'disabled' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}
        </select>
        ${u.id === myId ? '<span></span>' : `<button class="link small danger-text" data-remove="${u.id}">Remove</button>`}
      </div>`).join('') + (state.me.operator && !t.users.length ? '<p class="muted">Only you so far. Invite people below.</p>' : '')
      + (t.invites.length ? `<h2 style="margin-top:18px">Pending invites</h2>` + t.invites.map((i) => `<div class="member"><div>${esc(i.email)}<div class="muted small">${i.role} · expires ${day(i.expires)}</div></div>
          <button class="link small copy-inv" data-link="${location.origin}/invite/${i.token}">Copy link</button>
          <button class="link small danger-text" data-revoke="${i.token}">Cancel</button></div>`).join('') : '');
    $$('[data-role]').forEach((s) => (s.onchange = async () => { try { await post(`/api/team/users/${s.dataset.role}`, { role: s.value }, 'PATCH'); } catch (err) { alertMsg(err.message); } showTeam(); }));
    $$('[data-remove]').forEach((b) => (b.onclick = async () => { try { await api(`/api/team/users/${b.dataset.remove}`, { method: 'DELETE' }); } catch (err) { alertMsg(err.message); } showTeam(); }));
    $$('[data-revoke]').forEach((b) => (b.onclick = async () => { await api(`/api/team/invites/${b.dataset.revoke}`, { method: 'DELETE' }); showTeam(); }));
    $$('.copy-inv').forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.link); b.textContent = 'Copied ✓'; } catch { b.textContent = b.dataset.link; } }));
  }
  function alertMsg(m) { $('#invite-msg').textContent = m; }
  $('#invite-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await post('/api/team/invite', { email: $('#invite-email').value, role: $('#invite-role').value });
      $('#invite-msg').innerHTML = (r.emailed ? 'Invite emailed. ' : 'Send them this link: ') + `<a href="${esc(r.link)}">${esc(r.link)}</a>`;
      $('#invite-email').value = '';
      showTeam();
    } catch (err) { $('#invite-msg').textContent = err.message; }
  });

  // ------------------------------------------------------------ account and billing
  async function showAccount() {
    view('account');
    go('/account');
    state.me = await api('/api/me');
    renderBanner();
    const a = state.me.account, isOwner = state.me.user.role === 'owner';
    const status = new URLSearchParams(location.search).get('billing');
    $('#account-title').textContent = a.name;
    const pct = a.limit ? Math.min(100, Math.round((a.usage / a.limit) * 100)) : 0;
    $('#plan-panel').innerHTML = `
      ${status === 'success' ? '<p class="ok">Thank you! Your subscription is active.</p>' : ''}
      <div class="ph"><h2>${esc(a.planName)} plan</h2>${a.trialEnds ? `<span class="pill">Trial ends ${day(a.trialEnds)}</span>` : ''}</div>
      <p class="muted">${num(a.usage)} pageviews this month${a.limit ? ` of ${num(a.limit)}` : ''}${a.siteLimit ? ` · up to ${a.siteLimit} websites` : ''}.</p>
      ${a.limit ? `<div class="meter"><i style="width:${pct}%" class="${pct >= 100 ? 'over' : ''}"></i></div>` : ''}
      <p class="muted small">Signed in as ${esc(state.me.user.email)} (${state.me.user.role}).</p>
      ${a.hasBilling && isOwner ? '<button class="btn" id="portal-btn">Manage billing and invoices</button>' : ''}`;
    $('#portal-btn')?.addEventListener('click', async () => { try { location.href = (await post('/api/billing/portal')).url; } catch (err) { $('#plan-panel').insertAdjacentHTML('beforeend', `<p class="error">${esc(err.message)}</p>`); } });
    const showPlans = state.config.billing && a.plan !== 'operator';
    $('#plans').classList.toggle('hidden', !showPlans);
    if (showPlans) {
      $('#plans').innerHTML = state.config.plans.map((p) => `<div class="plan ${a.plan === p.id ? 'current' : ''}">
          <h3>${p.name}</h3><div class="price">$${p.price}<span>/month</span></div>
          <ul><li>${num(p.pageviews)} pageviews a month</li><li>${p.sites} websites</li><li>Funnels, goals, AI insights</li><li>Weekly email reports</li><li>Unlimited team members</li></ul>
          ${a.plan === p.id ? '<button class="btn" disabled>Current plan</button>' : isOwner ? `<button class="btn primary" data-plan="${p.id}">${a.hasBilling ? 'Switch' : 'Choose'} ${p.name}</button>` : '<p class="muted small">Ask the account owner to upgrade.</p>'}
        </div>`).join('');
      $$('[data-plan]').forEach((b) => (b.onclick = async () => {
        b.disabled = true; b.textContent = 'Opening checkout…';
        try { location.href = a.hasBilling ? (await post('/api/billing/portal')).url : (await post('/api/billing/checkout', { plan: b.dataset.plan })).url; }
        catch (err) { b.disabled = false; b.textContent = err.message; }
      }));
    }
    $('#password-form').classList.toggle('hidden', state.me.operator);
  }
  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await post('/api/account/password', { current: $('#pw-current').value, password: $('#pw-new').value }); $('#pw-msg').textContent = 'Password updated.'; e.target.reset(); }
    catch (err) { $('#pw-msg').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await post('/api/logout'); location.href = '/login'; });

  // ------------------------------------------------------------ operator
  async function showAdmin() {
    view('admin');
    go('/admin');
    const r = await api('/api/admin/accounts');
    $('#admin-kpis').innerHTML = [['Monthly revenue', '$' + num(r.mrr)], ['Paying customers', r.paying], ['On free trial', r.trials], ['All accounts', r.accounts.length]]
      .map(([l, v]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');
    $('#admin-list').innerHTML = r.accounts.length ? `<table class="tbl"><thead><tr><th>Customer</th><th>Plan</th><th>Pageviews this month</th><th>Sites</th><th>People</th><th>Joined</th></tr></thead><tbody>
      ${r.accounts.map((a) => `<tr><td><b>${esc(a.name)}</b><div class="muted small">${esc(a.owner || '')}</div></td>
        <td>${esc(a.planName)}${a.state === 'expired' ? ' <span class="tag bad">expired</span>' : a.state === 'over_limit' ? ' <span class="tag bad">over limit</span>' : a.mrr ? ` <span class="tag good">$${a.mrr}/mo</span>` : ''}</td>
        <td>${num(a.usage)}${a.limit ? ` / ${num(a.limit)}` : ''}</td><td>${a.sites}</td><td>${a.users}</td><td>${day(a.created)}</td></tr>`).join('')}
      </tbody></table>` : `<p class="muted">No customers yet. ${state.config.signup ? `Share <a href="${location.origin}/">${location.origin}</a> to get your first sign-ups.` : 'Turn on sign-ups with ALLOW_SIGNUP=true.'}</p>`;
  }

  boot();
})();
