'use strict';
// The analyst: answers questions about a business in plain words, from its own numbers.
//
//   engine.query(siteId, spec)          one number, a ranking, or a trend (traffic, goals, sales, ads)
//   engine.explain(siteId, metric, p)   why a number moved: which sources, pages, countries, devices drove it
//   engine.recommendations(siteId)      next steps ranked by how much they are worth
//   ask(engine, site, question, opts)   a question in plain words -> an answer with the numbers behind it
//
// Works with no setup: a built-in parser understands common questions. With ANTHROPIC_API_KEY set,
// Claude reads the question, calls the same engine as tools, and writes the answer, so it can handle
// anything the data can answer. Either way every number comes from the database, never from the model.
const { channelOf, isPaid } = require('./business');

const DAY = 864e5;
const METRICS = {
  visitors: { label: 'visitors', unit: 'count', src: 'traffic' },
  pageviews: { label: 'pageviews', unit: 'count', src: 'traffic' },
  visits: { label: 'visits', unit: 'count', src: 'traffic' },
  bounce_rate: { label: 'bounce rate', unit: 'percent', src: 'traffic', lowerIsBetter: true },
  avg_duration: { label: 'average visit length', unit: 'seconds', src: 'traffic' },
  conversions: { label: 'conversions', unit: 'count', src: 'goals' },
  conversion_rate: { label: 'conversion rate', unit: 'percent', src: 'goals' },
  revenue: { label: 'revenue', unit: 'money', src: 'sales' },
  orders: { label: 'orders', unit: 'count', src: 'sales' },
  aov: { label: 'average order value', unit: 'money', src: 'sales' },
  revenue_per_visitor: { label: 'revenue per visitor', unit: 'money', src: 'sales' },
  ad_spend: { label: 'ad spend', unit: 'money', src: 'ads', lowerIsBetter: true },
  ad_clicks: { label: 'ad clicks', unit: 'count', src: 'ads' },
  roas: { label: 'return on ad spend', unit: 'ratio', src: 'ads' },
  cpa: { label: 'cost per order from ads', unit: 'money', src: 'ads', lowerIsBetter: true },
};
const DIMS = ['none', 'day', 'week', 'month', 'weekday', 'hour', 'source', 'channel', 'page', 'entry_page', 'country', 'device', 'browser', 'os', 'campaign', 'goal'];
const TIME_DIMS = ['day', 'week', 'month', 'weekday', 'hour'];
const PERIODS = ['today', 'yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days', 'this_month', 'last_month', 'this_year', 'last_12_months', 'all_time'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ADDITIVE = new Set(['visitors', 'pageviews', 'visits', 'conversions', 'revenue', 'orders', 'ad_spend', 'ad_clicks']);

// ---------------------------------------------------------------- periods
function resolvePeriod(name, now = Date.now(), tz = 0) {
  const p = PERIODS.includes(name) ? name : 'last_7_days';
  const off = tz * 60000;
  const sod = (t) => Math.floor((t + off) / DAY) * DAY - off;
  const today = sod(now);
  const local = new Date(now + off);
  const y = local.getUTCFullYear(), m = local.getUTCMonth();
  const monthStart = (yy, mm) => Date.UTC(yy, mm, 1) - off;
  let from, to = now, label;
  switch (p) {
    case 'today': from = today; label = 'today'; break;
    case 'yesterday': from = today - DAY; to = today; label = 'yesterday'; break;
    case 'last_14_days': from = today - 13 * DAY; label = 'in the last 14 days'; break;
    case 'last_30_days': from = today - 29 * DAY; label = 'in the last 30 days'; break;
    case 'last_90_days': from = today - 89 * DAY; label = 'in the last 90 days'; break;
    case 'this_month': from = monthStart(y, m); label = 'this month'; break;
    case 'last_month': from = monthStart(y, m - 1); to = monthStart(y, m); label = 'last month'; break;
    case 'this_year': from = Date.UTC(y, 0, 1) - off; label = 'this year'; break;
    case 'last_12_months': from = today - 364 * DAY; label = 'in the last 12 months'; break;
    case 'all_time': from = Date.UTC(2000, 0, 1); label = 'since you started'; break;
    default: from = today - 6 * DAY; label = 'in the last 7 days';
  }
  let prevFrom, prevTo;
  if (p === 'today') { prevFrom = from - DAY; prevTo = to - DAY; } // same hours yesterday
  else if (p === 'this_month') { prevFrom = monthStart(y, m - 1); prevTo = prevFrom + (to - from); }
  else if (p === 'last_month') { prevFrom = monthStart(y, m - 2); prevTo = from; }
  else if (p === 'all_time') { prevFrom = prevTo = null; }
  else { prevTo = from; prevFrom = from - (to - from); }
  return { name: p, from, to, label, prevFrom, prevTo, tz };
}
const PREV_LABEL = { today: 'the same time yesterday', yesterday: 'the day before', this_month: 'the same days last month', last_month: 'the month before' };

// ---------------------------------------------------------------- engine
function createEngine(db, { countryNames = {} } = {}) {
  try {
    db.function('channel_of', { deterministic: true }, (s) => channelOf(s));
    db.function('is_paid', { deterministic: true }, (m, c) => (isPaid(m, c) ? 1 : 0));
  } catch (e) { if (!/already/i.test(e.message)) throw e; }

  const COL = {
    e: { source: 'e.source', channel: 'channel_of(e.source)', page: 'e.path', country: 'e.country', device: 'e.device', browser: 'e.browser', os: 'e.os', campaign: 'e.utm_campaign', goal: 'e.name' },
    s: { source: 's.source', channel: 'channel_of(s.source)', page: 's.entry', entry_page: 's.entry', country: 's.country', device: 's.device', browser: 's.browser', os: 's.os', campaign: 's.utm_campaign' },
    o: { source: 'o.source', channel: 'channel_of(o.source)', page: 'o.page', entry_page: 'o.page', country: 'o.country', device: 'o.device', campaign: 'o.campaign' },
    a: { source: 'channel_of(a.channel)', channel: "CASE WHEN channel_of(a.channel) IN ('Other', 'Direct') THEN a.channel ELSE channel_of(a.channel) END", campaign: 'a.campaign' },
  };
  const TS = { e: 'e.ts', s: 's.start', o: 'o.ts' };

  function keyExpr(t, by, tz) {
    if (by === 'none') return "'total'";
    const off = Math.round(tz * 60000);
    if (TIME_DIMS.includes(by)) {
      if (t === 'a') return { day: 'a.day', week: "date(a.day, 'weekday 0', '-6 days')", month: 'substr(a.day, 1, 7)', weekday: "strftime('%w', a.day)" }[by] || null;
      const u = `(${TS[t]} + ${off}) / 1000, 'unixepoch'`;
      return { day: `strftime('%Y-%m-%d', ${u})`, week: `date(${u}, 'weekday 0', '-6 days')`, month: `strftime('%Y-%m', ${u})`, weekday: `strftime('%w', ${u})`, hour: `strftime('%H', ${u})` }[by];
    }
    return COL[t][by] || null;
  }
  // returns { sql, args } or null when this table cannot be filtered that way
  function filterSql(t, siteId, filters) {
    const sql = [], args = [];
    for (const [dim, val] of Object.entries(filters || {})) {
      if (val == null || val === '') continue;
      if (t === 's' && dim === 'page') { sql.push("s.id IN (SELECT session_id FROM events WHERE site_id = ? AND name = 'pageview' AND path = ?)"); args.push(siteId, val); continue; }
      if (t === 's' && dim === 'goal') { sql.push('s.id IN (SELECT session_id FROM events WHERE site_id = ? AND name = ?)'); args.push(siteId, val); continue; }
      if (t === 'e' && dim === 'entry_page') { sql.push('e.session_id IN (SELECT id FROM sessions WHERE site_id = ? AND entry = ?)'); args.push(siteId, val); continue; }
      const col = COL[t][dim];
      if (!col) return null;
      if (val === '(none)') sql.push(`${col} IS NULL`);
      else if (dim === 'source' || dim === 'channel' || dim === 'campaign') { sql.push(`lower(${col}) = lower(?)`); args.push(val); }
      else { sql.push(`${col} = ?`); args.push(val); }
    }
    return { sql: sql.length ? ' AND ' + sql.join(' AND ') : '', args };
  }
  const localDay = (ts, tz) => new Date(ts + tz * 60000).toISOString().slice(0, 10);

  // ---- base aggregates, each returns Map(key -> numbers) or null when the dimension does not apply
  function traffic(siteId, from, to, by, filters, tz) {
    const out = new Map();
    const get = (k) => { if (!out.has(k)) out.set(k, { visitors: 0, pageviews: 0, visits: 0, bounces: 0, dur: 0 }); return out.get(k); };
    const useSessionsForVisitors = by === 'entry_page';
    const ek = keyExpr('e', by, tz), ef = filterSql('e', siteId, filters);
    if (!useSessionsForVisitors && ek && ef) {
      const nameClause = by === 'page' ? " AND e.name = 'pageview'" : by === 'goal' ? " AND e.name NOT IN ('pageview', 'engagement')" : '';
      for (const r of db.prepare(`SELECT ${ek} AS k, COUNT(DISTINCT e.visitor) AS v, SUM(e.name = 'pageview') AS p FROM events e
          WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ?${nameClause}${ef.sql} GROUP BY k`).all(siteId, from, to, ...ef.args)) {
        const x = get(r.k ?? '(none)'); x.visitors = r.v || 0; x.pageviews = r.p || 0;
      }
    }
    const sk = keyExpr('s', by, tz), sf = filterSql('s', siteId, filters);
    if (sk && sf) {
      for (const r of db.prepare(`SELECT ${sk} AS k, COUNT(*) AS n, COUNT(DISTINCT s.visitor) AS v, SUM(s.pageviews <= 1) AS b, SUM(MAX(s.last - s.start, s.engaged)) AS d
          FROM sessions s WHERE s.site_id = ? AND s.start >= ? AND s.start < ?${sf.sql} GROUP BY k`).all(siteId, from, to, ...sf.args)) {
        const x = get(r.k ?? '(none)'); x.visits = r.n || 0; x.bounces = r.b || 0; x.dur = r.d || 0;
        if (useSessionsForVisitors) x.visitors = r.v || 0;
      }
    }
    if (!out.size && (!ek || !ef) && (!sk || !sf)) return null;
    return out;
  }
  function goals(siteId, from, to, by, filters, tz, goal) {
    const ek = keyExpr('e', by, tz), ef = filterSql('e', siteId, filters);
    if (!ek || !ef) return null;
    const g = goal ? ' AND lower(e.name) = lower(?)' : " AND e.name NOT IN ('pageview', 'engagement')";
    const out = new Map();
    for (const r of db.prepare(`SELECT ${ek} AS k, COUNT(DISTINCT e.visitor) AS c FROM events e WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ?${g}${ef.sql} GROUP BY k`)
      .all(siteId, from, to, ...(goal ? [goal] : []), ...ef.args)) out.set(r.k ?? '(none)', { conversions: r.c || 0 });
    return out;
  }
  function sales(siteId, from, to, by, filters, tz, paidOnly = false, channels = null) {
    const ok = keyExpr('o', by, tz), of = filterSql('o', siteId, filters);
    if (!ok || !of) return null;
    let extra = paidOnly ? ' AND is_paid(o.medium, o.campaign) = 1' : '';
    const args = [];
    if (channels) { extra += ` AND channel_of(o.source) IN (${channels.map(() => '?').join(',') || "''"})`; args.push(...channels); }
    const key = by === 'campaign' ? `lower(${ok})` : ok;
    const out = new Map();
    for (const r of db.prepare(`SELECT ${key} AS k, SUM(o.amount) AS rev, SUM(o.amount > 0) AS n FROM orders o
        WHERE o.site_id = ? AND o.ts >= ? AND o.ts < ?${extra}${of.sql} GROUP BY k`).all(siteId, from, to, ...args, ...of.args))
      out.set(r.k ?? '(none)', { revenue: Math.round((r.rev || 0) * 100) / 100, orders: r.n || 0 });
    return out;
  }
  function ads(siteId, from, to, by, filters, tz) {
    const ak = keyExpr('a', by, tz), af = filterSql('a', siteId, filters);
    if (!ak || !af) return null;
    const key = by === 'campaign' ? `lower(${ak})` : ak;
    const out = new Map();
    for (const r of db.prepare(`SELECT ${key} AS k, MAX(${ak}) AS label, SUM(a.spend) AS s, SUM(a.clicks) AS c, SUM(a.impressions) AS i FROM ad_spend a
        WHERE a.site_id = ? AND a.day >= ? AND a.day <= ?${af.sql} GROUP BY k`).all(siteId, localDay(from, tz), localDay(to - 1, tz), ...af.args))
      out.set(r.k ?? '(none)', { spend: Math.round((r.s || 0) * 100) / 100, clicks: r.c, impressions: r.i, label: r.label });
    return out;
  }
  // Sales that ads can take credit for: tagged as paid (utm_medium=cpc, a campaign, ...). If nothing is tagged,
  // fall back to every sale from the channels that had spend, and say the number is approximate.
  function attributed(siteId, from, to, by, filters, tz) {
    const spendBy = ads(siteId, from, to, 'channel', {}, tz);
    const channels = spendBy ? [...spendBy.keys()] : [];
    const salesBy = by === 'source' ? 'channel' : by;
    const paid = sales(siteId, from, to, salesBy, filters, tz, true);
    const paidTotal = paid ? [...paid.values()].reduce((s, x) => s + x.revenue, 0) : 0;
    if (paidTotal > 0 || !channels.length) return { map: paid, approx: false };
    return { map: by === 'campaign' ? paid : sales(siteId, from, to, salesBy, filters, tz, false, channels), approx: true };
  }

  // ---- metric values by key
  function values(metric, siteId, from, to, by, filters, tz, goal) {
    const M = METRICS[metric];
    const notes = [];
    let map = new Map();
    const ratio = (a, b, f) => (b ? f(a, b) : null);
    if (M.src === 'traffic' || metric === 'conversion_rate' || metric === 'revenue_per_visitor') {
      var t = traffic(siteId, from, to, by, filters, tz);
      if (!t) return { map: null, notes: [`I can't split ${M.label} by ${dimLabel(by)}.`] };
    }
    switch (metric) {
      case 'visitors': case 'pageviews': case 'visits':
        for (const [k, x] of t) map.set(k, x[metric]); break;
      case 'bounce_rate': for (const [k, x] of t) map.set(k, ratio(x.bounces, x.visits, (a, b) => Math.round((100 * a) / b))); break;
      case 'avg_duration': for (const [k, x] of t) map.set(k, ratio(x.dur, x.visits, (a, b) => Math.round(a / b / 1000))); break;
      case 'conversions': case 'conversion_rate': {
        const g = goals(siteId, from, to, by, filters, tz, by === 'goal' ? null : goal);
        if (!g) return { map: null, notes: [`I can't split ${M.label} by ${dimLabel(by)}.`] };
        if (metric === 'conversions') for (const [k, x] of g) map.set(k, x.conversions);
        else if (by === 'goal') { const all = traffic(siteId, from, to, 'none', filters, tz).get('total')?.visitors || 0; for (const [k, x] of g) map.set(k, ratio(x.conversions, all, (a, b) => Math.round((1000 * a) / b) / 10)); }
        else for (const [k, x] of t) map.set(k, ratio(g.get(k)?.conversions || 0, x.visitors, (a, b) => Math.round((1000 * a) / b) / 10));
        break;
      }
      case 'revenue': case 'orders': case 'aov': case 'revenue_per_visitor': {
        const s = sales(siteId, from, to, by, filters, tz);
        if (!s) return { map: null, notes: [`Sales can't be split by ${dimLabel(by)} (orders don't carry that).`] };
        if (metric === 'revenue_per_visitor') { for (const [k, x] of t) map.set(k, ratio(s.get(k)?.revenue || 0, x.visitors, (a, b) => Math.round((100 * a) / b) / 100)); break; }
        for (const [k, x] of s) map.set(k, metric === 'aov' ? ratio(x.revenue, x.orders, (a, b) => Math.round((100 * a) / b) / 100) : x[metric]);
        break;
      }
      case 'ad_spend': case 'ad_clicks': {
        const a = ads(siteId, from, to, by, filters, tz);
        if (!a) return { map: null, notes: [`Ad spend can only be split by channel, campaign or time.`] };
        for (const [k, x] of a) map.set(k, metric === 'ad_spend' ? x.spend : x.clicks);
        if (by === 'campaign') map.labels = new Map([...a].map(([k, x]) => [k, x.label]));
        break;
      }
      case 'roas': case 'cpa': {
        const a = ads(siteId, from, to, by === 'source' ? 'channel' : by, filters, tz);
        if (!a) return { map: null, notes: ['Ad results can only be split by channel, campaign or time.'] };
        const { map: s, approx } = attributed(siteId, from, to, by, filters, tz);
        if (approx) notes.push('None of your sales are tagged as coming from ads (utm_medium=cpc or a utm_campaign), so I counted every sale from the channels you advertise on. Tag your ad links for exact numbers.');
        for (const [k, x] of a) {
          const sx = s?.get(k) || { revenue: 0, orders: 0 };
          map.set(k, metric === 'roas' ? ratio(sx.revenue, x.spend, (r, sp) => Math.round((100 * r) / sp) / 100) : ratio(x.spend, sx.orders, (sp, n) => Math.round((100 * sp) / n) / 100));
        }
        if (by === 'campaign') map.labels = new Map([...a].map(([k, x]) => [k, x.label]));
        break;
      }
    }
    return { map, notes };
  }

  function label(by, k, labels) {
    if (labels?.get(k)) return labels.get(k);
    if (k === '(none)' || k == null) return by === 'campaign' ? 'No campaign' : 'Unknown';
    if (by === 'weekday') return WEEKDAYS[+k];
    if (by === 'hour') return `${+k}:00`;
    if (by === 'day') return new Date(k + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    if (by === 'week') return 'Week of ' + new Date(k + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    if (by === 'month') return new Date(k + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    if (by === 'country') return countryNames[k] || k;
    return String(k);
  }
  function timeKeys(by, from, to, tz) {
    const out = [], seen = new Set();
    for (let t = from; t < to; t += DAY) {
      const d = localDay(t, tz);
      const k = by === 'day' ? d : by === 'month' ? d.slice(0, 7) : (() => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); })();
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
  }

  // spec: { metric, by, period, filters, goal, sort, limit, compare, tz, now }
  function query(siteId, spec) {
    const metric = METRICS[spec.metric] ? spec.metric : 'visitors';
    const by = DIMS.includes(spec.by) ? spec.by : 'none';
    const tz = +spec.tz || 0;
    const r = resolvePeriod(spec.period, spec.now, tz);
    const filters = cleanFilters(spec.filters);
    const goal = spec.goal || null;
    const M = METRICS[metric];
    const cur = values(metric, siteId, r.from, r.to, by, filters, tz, goal);
    const tot = values(metric, siteId, r.from, r.to, 'none', filters, tz, goal);
    const hasPrev = r.prevFrom != null && spec.compare !== false;
    const prevTot = hasPrev ? values(metric, siteId, r.prevFrom, r.prevTo, 'none', filters, tz, goal) : null;
    const prevRows = hasPrev && by !== 'none' && !TIME_DIMS.includes(by) ? values(metric, siteId, r.prevFrom, r.prevTo, by, filters, tz, goal) : null;
    const total = tot.map?.get('total') ?? (ADDITIVE.has(metric) ? 0 : null);
    const previous = prevTot ? prevTot.map?.get('total') ?? (ADDITIVE.has(metric) ? 0 : null) : null;
    let rows = [];
    if (cur.map && by !== 'none') {
      let keys = [...cur.map.keys()];
      if (['day', 'week', 'month'].includes(by)) {
        const all = timeKeys(by, r.from, r.to, tz);
        if (all.length <= 400) keys = all;
      }
      rows = keys.map((k) => ({ key: k, label: label(by, k, cur.map.labels), value: cur.map.get(k) ?? (ADDITIVE.has(metric) && TIME_DIMS.includes(by) ? 0 : null),
        previous: prevRows?.map ? prevRows.map.get(k) ?? (ADDITIVE.has(metric) ? 0 : null) : undefined })).filter((x) => x.value != null);
      if (TIME_DIMS.includes(by)) rows.sort((a, b) => (by === 'weekday' || by === 'hour' ? +a.key - +b.key : a.key.localeCompare(b.key)));
      else {
        // rates on tiny segments are noise: rank rate metrics only among segments with some volume
        if (!ADDITIVE.has(metric) && ['bounce_rate', 'conversion_rate', 'avg_duration', 'revenue_per_visitor'].includes(metric)) {
          const vol = traffic(siteId, r.from, r.to, by, filters, tz);
          const tv = [...(vol?.values() || [])].reduce((s, x) => s + x.visits, 0);
          const min = Math.max(5, tv * 0.01);
          rows = rows.filter((x) => (vol?.get(x.key)?.visits || 0) >= min);
          for (const x of rows) x.volume = vol.get(x.key).visitors;
        }
        const dir = spec.sort === 'asc' ? 1 : -1;
        rows.sort((a, b) => dir * (a.value - b.value) || String(a.label).localeCompare(String(b.label)));
        rows = rows.slice(0, Math.min(Math.max(+spec.limit || 10, 1), 50));
      }
    }
    return {
      metric, metricLabel: M.label, unit: M.unit, lowerIsBetter: !!M.lowerIsBetter, by, byLabel: dimLabel(by), goal, filters,
      period: { name: r.name, label: r.label, from: r.from, to: r.to, previousLabel: PREV_LABEL[r.name] || 'the period before' },
      total, previous, change: pctChange(total, previous), rows, notes: [...new Set([...(cur.notes || []), ...(tot.notes || [])])],
    };
  }

  // Why did a number move? Break the change down by every dimension and keep the biggest contributors.
  function explain(siteId, metric, period, opts = {}) {
    metric = METRICS[metric] ? metric : 'visitors';
    const base = query(siteId, { metric, period, by: 'none', filters: opts.filters, goal: opts.goal, tz: opts.tz, now: opts.now });
    const M = METRICS[metric];
    const dims = M.src === 'sales' ? ['channel', 'campaign', 'entry_page', 'country', 'device'] : M.src === 'ads' ? ['channel', 'campaign'] : ['source', 'entry_page', 'country', 'device', 'campaign'];
    const driverMetric = ADDITIVE.has(metric) ? metric : M.src === 'sales' ? 'revenue' : M.src === 'ads' ? 'ad_spend' : M.src === 'goals' ? 'conversions' : 'visits';
    const dirSign = Math.sign((base.total || 0) - (base.previous || 0)) || -1;
    const drivers = [], counter = [];
    for (const dim of dims) {
      const q = query(siteId, { metric: driverMetric, by: dim, period, filters: opts.filters, goal: opts.goal, tz: opts.tz, now: opts.now, limit: 50 });
      const moves = q.rows.filter((x) => x.previous !== undefined && x.key !== '(none)').map((x) => ({ dim, dimLabel: dimLabel(dim), key: x.key, label: x.label, now: x.value || 0, before: x.previous || 0, delta: (x.value || 0) - (x.previous || 0) }));
      moves.sort((a, b) => dirSign * (b.delta - a.delta));
      for (const mv of moves.slice(0, 2)) if (Math.sign(mv.delta) === dirSign && Math.abs(mv.delta) > 0) drivers.push(mv);
      const opp = moves.filter((x) => Math.sign(x.delta) === -dirSign).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
      if (opp) counter.push(opp);
    }
    const totalDelta = Math.abs((base.total || 0) - (base.previous || 0)) || 1;
    drivers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    for (const d of drivers) d.share = Math.round((100 * Math.abs(d.delta)) / totalDelta);
    counter.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const warnings = [];
    const last = db.prepare('SELECT MAX(ts) t FROM events WHERE site_id = ?').get(siteId).t;
    if (last && Date.now() - last > DAY && base.change != null && base.change < 0) warnings.push(`No visits have been recorded since ${new Date(last).toUTCString().slice(0, 22)} UTC. Check that the tracking snippet is still on your site.`);
    return { ...base, driverMetric, drivers: dedupeDrivers(drivers).slice(0, 4), counter: counter.slice(0, 2), warnings };
  }

  // Next steps, worth the most first. Each one says why, with the numbers.
  function recommendations(siteId, { tz = 0, currency = 'USD', now } = {}) {
    const P = 'last_30_days';
    const recs = [];
    const fmt = (m, v) => formatValue(m, v, currency);
    const conn = connected(siteId);
    const visitors = query(siteId, { metric: 'visitors', period: P, tz, now });
    const conv = query(siteId, { metric: 'conversions', period: P, tz, now, compare: false });
    const rev = conn.sales ? query(siteId, { metric: 'revenue', period: P, tz, now, compare: false }) : null;
    const orders = conn.sales ? query(siteId, { metric: 'orders', period: P, tz, now, compare: false }) : null;
    const aov = orders?.total ? rev.total / orders.total : 0;

    if (conn.ads) {
      for (const ch of query(siteId, { metric: 'roas', by: 'channel', period: P, tz, now, compare: false }).rows) {
        const spend = query(siteId, { metric: 'ad_spend', period: P, filters: { channel: ch.key }, tz, now, compare: false }).total || 0;
        if (spend < 20) continue;
        if (ch.value < 1) recs.push({ kind: 'ads_losing', tone: 'bad', score: spend * (1 - ch.value),
          title: `Rethink your ${ch.label} ads`, why: `You spent ${fmt('ad_spend', spend)} on ${ch.label} in the last 30 days and it brought back ${fmt('revenue', spend * ch.value)} in sales (${fmt('roas', ch.value)} return). You are losing money on it.`,
          action: `Pause the weakest campaigns, or send the ads to the page that sells best.`, ask: `Which ${ch.label} campaigns are losing money?` });
        else if (ch.value >= 3) recs.push({ kind: 'ads_winning', tone: 'good', score: spend * (ch.value - 1) * 0.3,
          title: `Put more into ${ch.label} ads`, why: `Every ${fmt('ad_spend', 1)} on ${ch.label} brought back ${fmt('revenue', ch.value)} in the last 30 days (${fmt('ad_spend', spend)} spent).`,
          action: `Raise the budget a step (say 20%) and watch whether the return holds.`, ask: `How did ${ch.label} ads do each week?` });
      }
      const spendByCampaign = query(siteId, { metric: 'ad_spend', by: 'campaign', period: P, tz, now, compare: false, limit: 50 }).rows;
      const roasByCampaign = new Map(query(siteId, { metric: 'roas', by: 'campaign', period: P, tz, now, compare: false, limit: 50 }).rows.map((x) => [x.key, x.value]));
      for (const c of spendByCampaign) {
        if (c.value >= 30 && (roasByCampaign.get(c.key) || 0) === 0 && c.key)
          recs.push({ kind: 'campaign_no_sales', tone: 'bad', score: c.value, title: `Pause "${c.label}"`,
            why: `This campaign cost ${fmt('ad_spend', c.value)} in the last 30 days and no sale came from it.`, action: 'Pause it, or check that its links carry utm_campaign so sales are matched to it.', ask: `How much did "${c.label}" spend each day?` });
      }
    }

    if (conv.total > 0) {
      const bySource = query(siteId, { metric: conn.sales ? 'revenue_per_visitor' : 'conversion_rate', by: 'source', period: P, tz, now, compare: false, limit: 20 }).rows.filter((x) => (x.volume || 0) >= 30);
      const avg = conn.sales ? (visitors.total ? rev.total / visitors.total : 0) : (visitors.total ? (100 * conv.total) / visitors.total : 0);
      // paid sources are judged by the ad rules above, not here
      const organic = bySource.filter((x) => (db.prepare('SELECT AVG(is_paid(utm_medium, utm_campaign)) p FROM sessions WHERE site_id = ? AND source = ? AND start > ?').get(siteId, x.key, Date.now() - 30 * DAY).p || 0) < 0.5);
      const best = organic[0];
      if (best && avg > 0 && best.value >= avg * 1.5 && best.key !== 'Direct')
        recs.push({ kind: 'best_source', tone: 'good', score: (best.value - avg) * (best.volume || 0) * (conn.sales ? 1 : Math.max(aov, 10) / 100),
          title: `Get more visitors like the ones from ${best.label}`,
          why: conn.sales ? `A visitor from ${best.label} is worth ${fmt('revenue_per_visitor', best.value)}, against ${fmt('revenue_per_visitor', avg)} on average.` : `Visitors from ${best.label} convert at ${best.value}%, against ${Math.round(avg * 10) / 10}% on average.`,
          action: `Spend more of your time (or budget) on ${best.label}: post there more, or ask happy customers to share it there.`, ask: `Which sources convert best?` });

      const byDevice = query(siteId, { metric: 'conversion_rate', by: 'device', period: P, tz, now, compare: false }).rows;
      const mob = byDevice.find((x) => x.key === 'Mobile'), desk = byDevice.find((x) => x.key === 'Desktop');
      if (mob && desk && (mob.volume || 0) >= 50 && (desk.volume || 0) >= 30 && desk.value > 0 && mob.value < desk.value * 0.6) {
        const extra = Math.round(((desk.value - mob.value) / 100) * mob.volume);
        recs.push({ kind: 'mobile_gap', tone: 'bad', score: extra * Math.max(aov, 10),
          title: 'Fix the experience on phones', why: `Phone visitors convert at ${mob.value}%, computer visitors at ${desk.value}%. If phones did as well, that would be about ${extra} more ${extra === 1 ? 'conversion' : 'conversions'} a month${aov ? ` (around ${fmt('revenue', extra * aov)})` : ''}.`,
          action: 'Go through your signup or checkout on a phone yourself: slow pages, small buttons and long forms are the usual culprits.', ask: 'How do phones and computers compare on conversion rate?' });
      }
    }

    const landing = query(siteId, { metric: 'bounce_rate', by: 'entry_page', period: P, tz, now, compare: false, limit: 20 }).rows;
    const visitsByEntry = query(siteId, { metric: 'visits', by: 'entry_page', period: P, tz, now, compare: false, limit: 50 }).rows;
    const vmap = new Map(visitsByEntry.map((x) => [x.key, x.value]));
    const leaky = landing.filter((x) => x.value >= 70 && (vmap.get(x.key) || 0) >= 40).sort((a, b) => (vmap.get(b.key) || 0) - (vmap.get(a.key) || 0))[0];
    if (leaky) recs.push({ kind: 'leaky_page', tone: 'bad', score: (vmap.get(leaky.key) * leaky.value) / 100 * (conv.total && visitors.total ? conv.total / visitors.total : 0.02) * Math.max(aov, 10),
      title: `Give people on ${leaky.label} a next step`, why: `${vmap.get(leaky.key)} visits started on ${leaky.label} in the last 30 days and ${leaky.value}% left without looking at anything else.`,
      action: 'Add one clear button near the top (to pricing, signup, or your best product), and make the first screen say what you offer.', ask: `How is ${leaky.label} doing over time?` });

    const rising = query(siteId, { metric: 'visitors', by: 'page', period: 'last_7_days', tz, now, limit: 20 }).rows
      .filter((x) => x.previous != null && x.value >= 30 && x.value >= x.previous * 1.5).sort((a, b) => b.value - b.previous - (a.value - a.previous))[0];
    if (rising) recs.push({ kind: 'rising_page', tone: 'good', score: (rising.value - rising.previous) * 0.5 * Math.max(aov, 10) * 0.02,
      title: `Make the most of ${rising.label}`, why: `It had ${rising.value} visitors this week, up from ${rising.previous}.`,
      action: 'Add a call to action there, link it from your home page, and share it again while it is hot.', ask: `Where are the visitors to ${rising.label} coming from?` });

    if (visitors.previous >= 50 && visitors.change <= -20) recs.push({ kind: 'traffic_down', tone: 'bad', score: (visitors.previous - visitors.total) * 0.5,
      title: `Find out why visitors fell ${Math.abs(visitors.change)}%`, why: `${visitors.total} visitors in the last 30 days, against ${visitors.previous} the 30 days before.`,
      action: 'Ask me "why did visitors drop?" and I will show which sources and pages lost the most.', ask: 'Why did visitors drop in the last 30 days?' });

    const wd = query(siteId, { metric: 'visitors', by: 'weekday', period: 'last_90_days', tz, now, compare: false }).rows;
    if (wd.length === 7) {
      const sorted = [...wd].sort((a, b) => b.value - a.value);
      if (sorted[0].value >= 50 && sorted[0].value >= sorted[6].value * 1.3)
        recs.push({ kind: 'best_day', tone: 'neutral', score: 1, title: `Launch things on ${sorted[0].label}s`,
          why: `${sorted[0].label} is your busiest day (${sorted[0].value.toLocaleString('en-US')} visitors on ${sorted[0].label}s over the last 90 days, against ${sorted[6].value.toLocaleString('en-US')} on ${sorted[6].label}s).`,
          action: `Send newsletters, publish posts and start promotions on ${sorted[0].label} mornings.`, ask: 'Which day of the week is busiest?' });
    }

    // setup gaps: the analyst gets much smarter with these
    if (!conn.goals) recs.push({ kind: 'setup_goals', tone: 'setup', score: 0.5, title: 'Tell me what counts as a win', why: 'No goals are tracked yet, so I can see visitors but not which ones sign up or buy.', action: "Add dearme('Signup') or dearme('Purchase', { revenue: 49 }) where it happens. See Settings.", setup: 'goals' });
    if (!conn.sales) recs.push({ kind: 'setup_sales', tone: 'setup', score: 0.4, title: 'Connect your sales', why: 'With sales connected I can tell you which sources, pages and ads actually make money.', action: 'Send revenue with your purchase goal, connect Stripe or Shopify, or upload a CSV. See Settings.', setup: 'sales' });
    if (!conn.ads && conn.sales) recs.push({ kind: 'setup_ads', tone: 'setup', score: 0.3, title: 'Add your ad costs', why: 'Add what you spend on Google, Meta or TikTok ads and I will tell you which ones pay for themselves.', action: 'Export a report by day from your ad account and upload it in Settings.', setup: 'ads' });

    recs.sort((a, b) => b.score - a.score);
    const seen = new Set();
    return recs.filter((r) => (seen.has(r.title) ? false : seen.add(r.title))).slice(0, 6).map(({ score, ...r }) => r);
  }

  function connected(siteId) {
    return {
      website: !!db.prepare('SELECT 1 FROM events WHERE site_id = ? LIMIT 1').get(siteId),
      goals: !!db.prepare("SELECT 1 FROM events WHERE site_id = ? AND name NOT IN ('pageview', 'engagement') LIMIT 1").get(siteId),
      sales: !!db.prepare('SELECT 1 FROM orders WHERE site_id = ? LIMIT 1').get(siteId),
      ads: !!db.prepare('SELECT 1 FROM ad_spend WHERE site_id = ? LIMIT 1').get(siteId),
    };
  }
  function knownValues(siteId) {
    const since = Date.now() - 90 * DAY;
    return {
      sources: db.prepare("SELECT source k, COUNT(*) n FROM sessions WHERE site_id = ? AND start > ? AND source IS NOT NULL GROUP BY source ORDER BY n DESC LIMIT 60").all(siteId, since).map((r) => r.k),
      goals: db.prepare("SELECT name k, COUNT(*) n FROM events WHERE site_id = ? AND ts > ? AND name NOT IN ('pageview', 'engagement') GROUP BY name ORDER BY n DESC LIMIT 30").all(siteId, since).map((r) => r.k),
      campaigns: db.prepare("SELECT k FROM (SELECT utm_campaign k FROM sessions WHERE site_id = ? AND start > ? AND utm_campaign IS NOT NULL UNION SELECT campaign FROM ad_spend WHERE site_id = ? AND campaign != '') LIMIT 60").all(siteId, since, siteId).map((r) => r.k),
      pages: db.prepare("SELECT path k, COUNT(*) n FROM events WHERE site_id = ? AND ts > ? AND name = 'pageview' GROUP BY path ORDER BY n DESC LIMIT 60").all(siteId, since).map((r) => r.k),
      channels: db.prepare('SELECT DISTINCT channel k FROM ad_spend WHERE site_id = ?').all(siteId).map((r) => r.k),
    };
  }

  return { query, explain, recommendations, connected, knownValues, resolvePeriod };
}

function dedupeDrivers(list) {
  const out = [], perDim = {};
  for (const d of list) {
    // the same story told twice (source "Google" and channel "Google") adds nothing
    if (out.some((x) => String(x.label).toLowerCase() === String(d.label).toLowerCase())) continue;
    perDim[d.dim] = (perDim[d.dim] || 0) + 1;
    if (perDim[d.dim] > 2) continue;
    out.push(d);
  }
  return out;
}
function cleanFilters(f) {
  const out = {};
  if (Array.isArray(f)) { for (const x of f) if (x && DIMS.includes(x.dim) && x.value != null) out[x.dim] = String(x.value).slice(0, 300); return out; }
  for (const [k, v] of Object.entries(f || {})) if (DIMS.includes(k) && !TIME_DIMS.includes(k) && k !== 'none' && v != null && v !== '') out[k] = String(v).slice(0, 300);
  return out;
}
const pctChange = (a, b) => (a == null || b == null ? null : b ? Math.round(((a - b) / Math.abs(b)) * 100) : a ? null : 0);
const dimLabel = (d) => ({ none: 'total', entry_page: 'landing page', weekday: 'day of the week', os: 'operating system', goal: 'goal' }[d] || d);

function formatValue(metric, v, currency = 'USD') {
  if (v == null) return '–';
  const unit = METRICS[metric]?.unit || 'count';
  if (unit === 'money') {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2, minimumFractionDigits: Math.abs(v) >= 1000 || Number.isInteger(v) ? 0 : 2 }).format(v); }
    catch { return `${currency} ${Math.round(v * 100) / 100}`; }
  }
  if (unit === 'percent') return `${v}%`;
  if (unit === 'ratio') return `${v}×`;
  if (unit === 'seconds') return v < 60 ? `${v}s` : `${Math.floor(v / 60)}m ${String(v % 60).padStart(2, '0')}s`;
  return Number(v).toLocaleString('en-US');
}

// ---------------------------------------------------------------- understanding a question (no AI needed)
const has = (s, re) => re.test(s);
function parseQuestion(question, ctx = {}) {
  const q = ` ${String(question).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ')} `;
  const prev = ctx.previous || {};
  const known = ctx.known || { sources: [], goals: [], campaigns: [], pages: [], channels: [] };
  const spec = { filters: {} };

  // intent
  let intent = 'query';
  if (has(q, /\b(what should i|what (can|could) i do|what do (i|you) (do|suggest|recommend)|next steps?|recommend|advice|advise|suggest|how (do|can|could) i (get|grow|increase|improve|sell|make|boost)|how to (get|grow|increase|improve|boost)|improve|priorit)/)) intent = 'advice';
  else if (has(q, /\b(why|what happened|what changed|what caused|explain|reason|how come)\b/)) intent = 'explain';
  else if (has(q, /\b(alerts?|anything (wrong|unusual|weird|odd|strange|new)|problems?|issues?|broken|anomal|what'?s going on|what is going on)\b/)) intent = 'alerts';
  else if (has(q, /\b(summary|summari[sz]e|overview|how am i doing|how are (we|things) doing|how did (i|we) do|how'?s business|report|recap)\b/)) intent = 'overview';

  // metric
  const METRIC_RULES = [
    [/\b(average order|avg\.? order|aov|basket size|order value)\b/, 'aov'],
    [/\b(roas|return on (ad|advertising)|ads? return|worth it|pay(ing)? (off|for (it|them)self)|profitable|making money|losing money)\b/, 'roas'],
    [/\b(cost per (sale|order|purchase|customer|acquisition|conversion|lead)|cpa|cac|acquisition cost)\b/, 'cpa'],
    [/\b(revenue|value|worth) per visitor\b/, 'revenue_per_visitor'],
    [/\b(ad spend|spend|spent|spending|ad costs?|advertising costs?|ads? budget|budget)\b/, 'ad_spend'],
    [/\b(ad clicks|clicks on (my )?ads)\b/, 'ad_clicks'],
    [/\b(conversion rate|convert|converting|conversion %)/, 'conversion_rate'],
    [/\b(orders|purchases|transactions|how many (sales|people bought|customers))\b/, 'orders'],
    [/\b(revenue|sales|sold|money|earn|earned|earnings|made|make|income|turnover|gmv)\b/, 'revenue'],
    [/\bbounce/, 'bounce_rate'],
    [/\b(time on (site|page)|duration|how long|engag|stay)/, 'avg_duration'],
    [/\b(conversions?|sign ?ups?|signed up|goals?|leads?|downloads?|registrations?|subscribers?|bookings?)\b/, 'conversions'],
    [/\b(pageviews?|page views?)\b/, 'pageviews'],
    [/\b(visits|sessions)\b/, 'visits'],
    [/\b(visitors?|traffic|people|users|audience|views|hits|came|come)\b/, 'visitors'],
  ];
  for (const [re, m] of METRIC_RULES) if (has(q, re)) { spec.metric = m; break; }
  for (const g of known.goals) if (g && q.includes(` ${g.toLowerCase()}`)) { spec.goal = g; if (!spec.metric || ['visitors', 'revenue'].includes(spec.metric) && !/revenue|sales|money/.test(q)) spec.metric = /rate|convert|%/.test(q) ? 'conversion_rate' : 'conversions'; break; }
  if (!spec.metric) spec.metric = intent === 'advice' ? 'visitors' : prev.metric || 'visitors';
  if (spec.metric === 'roas' && !has(q, /\b(roas|return|worth|pay|profitable|making money|losing money)/) ) spec.metric = 'roas';

  // dimension
  const DIM_RULES = [
    [/\bcampaigns?\b/, 'campaign'],
    [/\b(landing|entry|land on|landed)\b/, 'entry_page'],
    [/\b(day of (the )?week|weekday|which day|what day|busiest day|best day|slowest day)\b/, 'weekday'],
    [/\b(time of day|what time|which hour|hours?\b)/, 'hour'],
    [/\b(daily|each day|per day|by day|day by day|every day|trend|over time|chart|graph)\b/, 'day'],
    [/\b(weekly|each week|per week|by week|week by week)\b/, 'week'],
    [/\b(monthly|each month|per month|by month|month by month)\b/, 'month'],
    [/\b(countr(y|ies)|geograph|locations?|nations?|where (are|do) (my )?(visitors|customers|people|users) (live|located|based))\b/, 'country'],
    [/\b(devices?|mobile vs|phones? (vs|or|and) (computers?|desktop)|desktop vs|by device)\b/, 'device'],
    [/\bbrowsers?\b/, 'browser'],
    [/\b(operating systems?|by os)\b/, 'os'],
    [/\b(channels?|platforms?|which ads?|ad networks?)\b/, 'channel'],
    [/\b(sources?|referr|where .*(come|came|coming) from|traffic from|which (sites?|websites?)|social|search engines?)\b/, 'source'],
    [/\b(pages?|content|blog|posts?|articles?|urls?)\b/, 'page'],
    [/\b(goals|events|which (conversions|goals))\b/, 'goal'],
  ];
  for (const [re, d] of DIM_RULES) if (has(q, re)) { spec.by = d; break; }
  if (has(q, /\b(top|best|most|biggest|highest|worst|least|lowest|which|rank|breakdown|split|compare)\b/) && !spec.by && prev.by && prev.by !== 'none' && !TIME_DIMS.includes(prev.by)) spec.by = prev.by;
  if (['roas', 'cpa', 'ad_spend', 'ad_clicks'].includes(spec.metric) && spec.by === 'source') spec.by = 'channel';
  if (spec.metric === 'roas' && !spec.by && intent === 'query' && has(q, /\b(which|what|my ads|ads|all)\b/)) spec.by = has(q, /campaign/) ? 'campaign' : 'channel';
  if (!spec.by) spec.by = 'none';

  // period
  const PERIOD_RULES = [
    [/\btoday\b/, 'today'], [/\byesterday\b/, 'yesterday'],
    [/\b(14 days|two weeks|2 weeks|fortnight)\b/, 'last_14_days'],
    [/\b(this month|month to date|so far this month)\b/, 'this_month'],
    [/\b(last month|previous month)\b/, 'last_month'],
    [/\b(30 days|past month|thirty days|4 weeks|four weeks)\b/, 'last_30_days'],
    [/\b(90 days|quarter|3 months|three months)\b/, 'last_90_days'],
    [/\b(this year|year to date|ytd)\b/, 'this_year'],
    [/\b(12 months|past year|last year|twelve months)\b/, 'last_12_months'],
    [/\b(all time|ever|since (the )?(start|beginning)|in total|overall)\b/, 'all_time'],
    [/\b(this week|past week|last week|7 days|seven days|recently|lately)\b/, 'last_7_days'],
  ];
  for (const [re, p] of PERIOD_RULES) if (has(q, re)) { spec.period = p; break; }
  if (!spec.period) spec.period = prev.period || (['sales', 'ads'].includes(METRICS[spec.metric].src) || spec.by === 'weekday' ? 'last_30_days' : 'last_7_days');
  if (spec.by === 'month' && ['last_7_days', 'last_14_days', 'last_30_days'].includes(spec.period)) spec.period = 'last_12_months';
  if (spec.by === 'week' && ['last_7_days', 'last_14_days'].includes(spec.period)) spec.period = 'last_90_days';

  spec.sort = has(q, /\b(worst|least|lowest|bottom|fewest|weakest|underperform|losing|poorest|slowest)\b/) ? 'asc' : 'desc';

  // filters: "on mobile", "from Google", "in France", "/pricing"
  const devices = { mobile: 'Mobile', phone: 'Mobile', phones: 'Mobile', desktop: 'Desktop', computer: 'Desktop', computers: 'Desktop', laptop: 'Desktop', tablet: 'Tablet', tablets: 'Tablet', ipad: 'Tablet' };
  if (spec.by !== 'device') for (const [w, v] of Object.entries(devices)) if (new RegExp(`\\b(on|from|using|with) (a |my )?${w}\\b|\\b${w} (visitors|users|traffic|people|conversion)`).test(q)) { spec.filters.device = v; break; }
  if (!['source', 'channel'].includes(spec.by)) {
    const src = known.sources.filter((s) => s && s.length > 1 && !['direct'].includes(s.toLowerCase())).sort((a, b) => b.length - a.length)
      .find((s) => new RegExp(`(^|[^a-z0-9])${s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(q));
    const famWords = { google: 'Google', facebook: 'Meta', instagram: 'Meta', meta: 'Meta', tiktok: 'TikTok', linkedin: 'LinkedIn', bing: 'Microsoft', twitter: 'X', pinterest: 'Pinterest', reddit: 'Reddit', email: 'Email', newsletter: 'Email' };
    const fam = Object.entries(famWords).find(([w]) => new RegExp(`\\b${w}\\b`).test(q));
    if (fam && (METRICS[spec.metric].src === 'ads' || METRICS[spec.metric].src === 'sales' || /\bads?\b/.test(q))) spec.filters.channel = fam[1];
    else if (src) spec.filters.source = src;
    else if (fam) spec.filters.channel = fam[1];
  }
  if (spec.by !== 'campaign') { const camp = known.campaigns.find((c) => c && c.length > 2 && q.includes(c.toLowerCase())); if (camp) spec.filters.campaign = camp; }
  if (!['page', 'entry_page'].includes(spec.by)) { const m = /(^|\s)(\/[\w\-./]*)/.exec(question); if (m) spec.filters[/landing|entry|land/.test(q) ? 'entry_page' : 'page'] = m[2].length > 1 ? m[2].replace(/[.,?!]+$/, '') : '/'; }
  if (spec.by !== 'country' && ctx.countryNames) {
    for (const [code, name] of Object.entries(ctx.countryNames)) if (name && name.length > 3 && new RegExp(`\\b(in|from) (the )?${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)) { spec.filters.country = code; break; }
  }
  // "what about last month?" keeps the rest of the previous question
  const followUp = /^\s*(and|what about|how about|ok and|same for|now|vs|versus|compared)/i.test(question.trim()) || question.trim().split(/\s+/).length <= 4;
  if (followUp && prev.metric) {
    if (!Object.keys(spec.filters).length && prev.filters) spec.filters = { ...prev.filters };
    if (spec.by === 'none' && prev.by && intent === 'query' && !METRIC_RULES.some(([re]) => has(q, re))) spec.by = prev.by;
  }
  return { intent, spec };
}

// ---------------------------------------------------------------- answers in words
function words(metric, v, currency, goal) {
  const f = formatValue(metric, v, currency);
  return {
    visitors: `${f} ${v === 1 ? 'visitor' : 'visitors'}`, pageviews: `${f} pageviews`, visits: `${f} visits`,
    bounce_rate: `a bounce rate of ${f}`, avg_duration: `an average visit of ${f}`,
    conversions: `${f} ${goal ? `${goal} ${v === 1 ? 'conversion' : 'conversions'}` : v === 1 ? 'conversion' : 'conversions'}`, conversion_rate: `a ${goal ? goal + ' ' : ''}conversion rate of ${f}`,
    revenue: `${f} in sales`, orders: `${f} ${v === 1 ? 'order' : 'orders'}`, aov: `an average order of ${f}`, revenue_per_visitor: `${f} per visitor`,
    ad_spend: `${f} spent on ads`, ad_clicks: `${f} ad clicks`, roas: `${f} back for every ${formatValue('ad_spend', 1, currency).replace(/\.00$/, '')} spent on ads`, cpa: `${f} in ad spend per order`,
  }[metric] || f;
}
function filterWords(filters, countryNames = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(filters || {})) {
    if (k === 'device') parts.push(`on ${v === 'Mobile' ? 'phones' : v === 'Desktop' ? 'computers' : 'tablets'}`);
    else if (k === 'country') parts.push(`from ${countryNames[v] || v}`);
    else if (k === 'source' || k === 'channel') parts.push(`from ${v}`);
    else if (k === 'campaign') parts.push(`in the "${v}" campaign`);
    else if (k === 'page') parts.push(`on ${v}`);
    else if (k === 'entry_page') parts.push(`landing on ${v}`);
    else if (k === 'goal') parts.push(`who completed ${v}`);
  }
  return parts.length ? ' ' + parts.join(', ') : '';
}
function changeWords(r, currency) {
  if (r.previous == null || r.change == null) return '';
  const M = METRICS[r.metric];
  if (r.change === 0) return ` That's the same as ${r.period.previousLabel}.`;
  const dir = r.change > 0 ? 'up' : 'down';
  if (M.unit === 'percent') { const d = Math.round((r.total - r.previous) * 10) / 10; return ` That's ${dir} ${Math.abs(d)} points from ${formatValue(r.metric, r.previous, currency)} ${r.period.previousLabel}.`; }
  return ` That's ${dir} ${Math.abs(r.change)}% from ${formatValue(r.metric, r.previous, currency)} ${r.period.previousLabel}.`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const listWords = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs.at(-1));

function answerQuery(r, { currency, countryNames, connected }) {
  const M = METRICS[r.metric];
  const fw = filterWords(r.filters, countryNames);
  const out = { highlights: [], followUps: [] };
  if ((M.src === 'sales' && !connected.sales) || (M.src === 'ads' && !connected.ads) || (M.src === 'goals' && !connected.goals)) {
    out.answer = M.src === 'sales' ? "I don't have any sales data for this site yet, so I can't answer that. Connect your sales (send revenue with a Purchase goal, connect Stripe or Shopify, or upload a CSV) in Settings and ask again."
      : M.src === 'ads' ? "I don't have your ad costs yet. Export a report by day from Google Ads, Meta Ads or TikTok Ads and upload it in Settings, and I'll tell you which ads pay for themselves."
        : "No goals are tracked yet, so I can't count conversions. Add dearme('Signup') or dearme('Purchase', { revenue: 49 }) to your site where it happens (see Settings).";
    out.setup = M.src === 'goals' ? 'goals' : M.src;
    out.followUps = ['How many visitors did I have this week?', 'Where do my visitors come from?'];
    return out;
  }
  const subject = r.goal && !fw ? '' : fw;
  if (r.by === 'none') {
    out.answer = `${cap(r.period.label.replace(/^in the/, 'In the'))}${subject ? `,${subject}` : ''}, you had ${words(r.metric, r.total, currency, r.goal)}.${changeWords(r, currency)}`;
    if (r.metric === 'roas') out.answer = `${cap(r.period.label.replace(/^in the/, 'In the'))}${subject ? `,${subject}` : ''}, your ads brought back ${words(r.metric, r.total, currency)}.${changeWords(r, currency)}${r.total != null && r.total < 1 ? ' Your ads cost more than the sales they brought.' : r.total >= 3 ? ' That is a healthy return.' : ''}`;
    out.highlights.push({ label: cap(M.label), value: formatValue(r.metric, r.total, currency) });
    if (r.previous != null) out.highlights.push({ label: cap(r.period.previousLabel), value: formatValue(r.metric, r.previous, currency) });
    if (r.change != null) out.highlights.push({ label: 'Change', value: `${r.change > 0 ? '+' : ''}${r.change}%`, tone: (r.change > 0) !== !!M.lowerIsBetter ? 'good' : r.change === 0 ? 'neutral' : 'bad' });
    out.followUps = [M.src === 'ads' ? `Show ${M.label} by campaign` : M.src === 'sales' ? `Where did my ${M.label === 'revenue' ? 'sales' : M.label} come from?` : `Where did my ${M.label} come from?`,
      `Show ${M.label} day by day`, r.change ? `Why did ${M.label} ${r.change > 0 ? 'go up' : 'go down'}?` : 'What should I do next?'];
  } else if (TIME_DIMS.includes(r.by)) {
    const vals = r.rows.filter((x) => x.value != null);
    if (!vals.length || vals.every((x) => !x.value)) out.answer = `I found no ${M.label}${fw} ${r.period.label}.`;
    else if (r.by === 'weekday' || r.by === 'hour') {
      const s = [...vals].sort((a, b) => b.value - a.value);
      out.answer = `${s[0].label} is your strongest ${r.by === 'hour' ? 'hour' : 'day'} for ${M.label}${fw} (${formatValue(r.metric, s[0].value, currency)} ${r.period.label}), and ${s.at(-1).label} the weakest (${formatValue(r.metric, s.at(-1).value, currency)}).`;
    } else {
      const max = vals.reduce((a, b) => (b.value > a.value ? b : a)), min = vals.reduce((a, b) => (b.value < a.value ? b : a));
      const half = Math.floor(vals.length / 2);
      const avg = (xs) => xs.reduce((s, x) => s + x.value, 0) / (xs.length || 1);
      const first = avg(vals.slice(0, half)), second = avg(vals.slice(vals.length - half));
      const trend = half >= 2 && first ? Math.round(((second - first) / first) * 100) : 0;
      const unitWord = r.by === 'day' ? 'day' : r.by === 'week' ? 'week' : 'month';
      out.answer = `${cap(M.label)}${fw} peaked on ${max.label} (${formatValue(r.metric, max.value, currency)}) and ${min === max ? 'held steady' : `was lowest on ${min.label} (${formatValue(r.metric, min.value, currency)})`}. `
        + (ADDITIVE.has(r.metric) ? `That's ${formatValue(r.metric, Math.round((avg(vals) * 100)) / 100, currency)} a ${unitWord} on average. ` : '')
        + (Math.abs(trend) >= 10 ? `The trend is ${trend > 0 ? 'up' : 'down'}: the second half of the period averaged ${Math.abs(trend)}% ${trend > 0 ? 'more' : 'less'} than the first.` : 'Overall it has been fairly steady.');
    }
    out.followUps = [`Where did my ${M.label} come from?`, `Why did ${M.label} change?`, 'What should I do next?'];
  } else {
    const rows = r.rows.filter((x) => x.key !== '(none)' || r.rows.length === 1);
    if (!rows.length) out.answer = `I found no ${M.label}${fw} ${r.period.label}.`;
    else if (ADDITIVE.has(r.metric) && r.sort !== 'asc') {
      const tot = r.total || rows.reduce((s, x) => s + (x.value || 0), 0) || 1;
      const top = rows[0];
      const others = rows.slice(1, 3).map((x) => `${x.label} (${formatValue(r.metric, x.value, currency)})`);
      out.answer = `${top.label} brought the most ${M.label}${fw} ${r.period.label}: ${formatValue(r.metric, top.value, currency)}, or ${Math.round((100 * top.value) / tot)}% of the total.${others.length ? ` Next come ${listWords(others)}.` : ''}`;
      if (r.by === 'page' || r.by === 'entry_page') out.answer = `${top.label} is your top ${r.by === 'page' ? 'page' : 'landing page'} for ${M.label}${fw} ${r.period.label}, with ${formatValue(r.metric, top.value, currency)}.${others.length ? ` Then ${listWords(others)}.` : ''}`;
      const riser = rows.filter((x) => x.previous != null && x.previous >= 0).map((x) => ({ ...x, d: (x.value || 0) - (x.previous || 0) })).sort((a, b) => b.d - a.d)[0];
      if (riser && riser.d > 0 && riser.key !== top.key && riser.previous !== undefined) out.answer += ` ${riser.label} grew the most (${formatValue(r.metric, riser.previous, currency)} → ${formatValue(r.metric, riser.value, currency)}).`;
    } else {
      const best = rows[0];
      const word = r.sort === 'asc' ? 'lowest' : 'highest';
      const rest = rows.slice(1, 3).map((x) => `${x.label} (${formatValue(r.metric, x.value, currency)})`);
      out.answer = `${best.label} has the ${word} ${M.label}${fw} ${r.period.label}: ${formatValue(r.metric, best.value, currency)}${r.total != null && !ADDITIVE.has(r.metric) ? `, against ${formatValue(r.metric, r.total, currency)} overall` : ''}.${rest.length ? ` Then ${listWords(rest)}.` : ''}`;
      if (r.metric === 'roas') {
        const losing = rows.filter((x) => x.value < 1).map((x) => x.label);
        if (losing.length) out.answer += ` ${listWords(losing)} ${losing.length === 1 ? 'is' : 'are'} costing more than ${losing.length === 1 ? 'it brings' : 'they bring'} back.`;
      }
    }
    out.highlights = rows.slice(0, 3).map((x) => ({ label: x.label, value: formatValue(r.metric, x.value, currency) }));
    out.followUps = r.by === 'source' || r.by === 'channel'
      ? [r.metric !== 'conversion_rate' && connected.goals ? 'Which sources convert best?' : 'Which pages do they land on?', connected.sales && r.metric !== 'revenue' ? 'Which sources make the most money?' : `Show ${M.label} day by day`, 'What should I do next?']
      : [`Show ${M.label} by source`, `Show ${M.label} day by day`, 'What should I do next?'];
  }
  if (r.notes?.length) out.answer += ' ' + r.notes.join(' ');
  return out;
}

function answerExplain(x, { currency }) {
  const M = METRICS[x.metric];
  const out = { highlights: [], followUps: [] };
  if (x.previous == null) { out.answer = `I need an earlier period to compare with. Try "why did ${M.label} change this week?"`; return out; }
  const pct = x.change;
  if (!x.total && !x.previous) { out.answer = `There were no ${M.label} ${x.period.label} or ${x.period.previousLabel}, so nothing changed.`; return out; }
  const dir = (x.total || 0) > (x.previous || 0) ? 'up' : (x.total || 0) < (x.previous || 0) ? 'down' : 'flat';
  out.answer = dir === 'flat' ? `${cap(M.label)} ${x.period.label} (${formatValue(x.metric, x.total, currency)}) is the same as ${x.period.previousLabel}.`
    : `${cap(M.label)} ${dir === 'up' ? 'went up' : 'went down'}${pct != null ? ` ${Math.abs(pct)}%` : ''} ${x.period.label}, from ${formatValue(x.metric, x.previous, currency)} to ${formatValue(x.metric, x.total, currency)} (compared with ${x.period.previousLabel}).`;
  if (dir !== 'flat' && pct != null && Math.abs(pct) < 5) out.answer += ' That is a small change, within normal ups and downs.';
  const dm = x.driverMetric;
  const dWords = (d) => {
    const amount = formatValue(dm, Math.abs(d.delta), currency);
    const what = METRICS[dm].label;
    if (d.dim === 'source' || d.dim === 'channel') return `${d.label} sent ${amount} ${d.delta > 0 ? 'more' : 'fewer'} ${what} (${formatValue(dm, d.before, currency)} → ${formatValue(dm, d.now, currency)})`;
    if (d.dim === 'entry_page') return `${d.label} as a landing page ${d.delta > 0 ? 'gained' : 'lost'} ${amount} ${what}`;
    if (d.dim === 'country') return `${d.label} ${d.delta > 0 ? 'added' : 'lost'} ${amount} ${what}`;
    if (d.dim === 'device') return `${d.label === 'Mobile' ? 'phones' : d.label === 'Desktop' ? 'computers' : d.label} ${d.delta > 0 ? 'added' : 'lost'} ${amount} ${what}`;
    if (d.dim === 'campaign') return `the "${d.label}" campaign ${d.delta > 0 ? 'added' : 'lost'} ${amount} ${what}`;
    return `${d.label} ${d.delta > 0 ? '+' : '−'}${amount}`;
  };
  if (dir !== 'flat' && x.drivers.length) {
    const main = x.drivers.filter((d) => d.dim === 'source' || d.dim === 'channel')[0] || x.drivers[0];
    const rest = x.drivers.filter((d) => d !== main).slice(0, 2);
    out.answer += ` The biggest reason: ${dWords(main)}${main.share && main.share <= 100 ? `, which explains about ${main.share}% of the change` : ''}.`;
    if (rest.length) out.answer += ` Also: ${listWords(rest.map(dWords))}.`;
    if (x.counter[0] && Math.abs(x.counter[0].delta) > 0) out.answer += ` Going the other way, ${dWords(x.counter[0])}.`;
  }
  if (x.warnings?.length) out.answer += ' ' + x.warnings.join(' ');
  out.highlights = [{ label: cap(M.label), value: formatValue(x.metric, x.total, currency) }, { label: cap(x.period.previousLabel), value: formatValue(x.metric, x.previous, currency) }]
    .concat(pct != null ? [{ label: 'Change', value: `${pct > 0 ? '+' : ''}${pct}%`, tone: (pct > 0) !== !!M.lowerIsBetter ? 'good' : pct === 0 ? 'neutral' : 'bad' }] : []);
  out.drivers = x.drivers.map((d) => ({ dim: d.dimLabel, label: d.label, before: d.before, now: d.now, delta: d.delta, metric: dm }));
  out.followUps = [x.drivers[0] ? `Show ${METRICS[dm].label} from ${x.drivers[0].label} day by day` : `Show ${M.label} day by day`, 'What should I do next?', `Where did my ${M.label} come from?`];
  return out;
}

// ---------------------------------------------------------------- ask
async function ask(engine, site, question, opts = {}) {
  const tz = +opts.tz || 0;
  const currency = site.currency || 'USD';
  const countryNames = opts.countryNames || {};
  const connected = engine.connected(site.id);
  const known = engine.knownValues(site.id);
  const now = opts.now;

  if (process.env.ANTHROPIC_API_KEY && opts.ai !== false) {
    try {
      const r = await askClaude(engine, site, question, { ...opts, tz, currency, connected, known, now });
      if (r) return r;
    } catch (e) { console.error('Analyst AI failed, answering without it:', e.message); }
  }

  const { intent, spec } = parseQuestion(question, { previous: opts.context, known, countryNames });
  spec.tz = tz; spec.now = now;
  const base = { question, intent, spec: { metric: spec.metric, by: spec.by, period: spec.period, filters: spec.filters, goal: spec.goal || null }, ai: false };

  if (intent === 'advice') {
    const recs = engine.recommendations(site.id, { tz, currency, now });
    const real = recs.filter((r) => r.tone !== 'setup');
    return { ...base, answer: real.length ? `Here's where I'd focus, most valuable first. ${real.slice(0, 3).map((r, i) => `${i + 1}. ${r.title}: ${r.why}`).join(' ')}`
      : `I need a bit more data before I can give you sharp advice. ${recs.slice(0, 2).map((r) => r.why).join(' ')}`,
      nextSteps: recs, followUps: real[0]?.ask ? [real[0].ask, 'Why did visitors change this week?', 'Which sources convert best?'] : ['Where do my visitors come from?', 'How many visitors did I have this week?'] };
  }
  if (intent === 'alerts') {
    const list = (opts.alerts || []).slice(0, 5);
    return { ...base, answer: list.length ? `Here's what I noticed recently: ${list.map((a) => a.title + (a.body ? ` (${a.body})` : '')).join(' ')}` : "Nothing unusual in the last few days. I check every hour and will flag drops, spikes, tracking problems and ads that aren't paying off.",
      alerts: list, followUps: ['Why did visitors change this week?', 'What should I do next?'] };
  }
  if (intent === 'explain') {
    const x = engine.explain(site.id, spec.metric, spec.period === 'all_time' ? 'last_7_days' : spec.period, { filters: spec.filters, goal: spec.goal, tz, now });
    const a = answerExplain(x, { currency });
    return { ...base, ...a, evidence: evidenceOf(x.drivers.length ? null : x, currency) };
  }
  if (intent === 'overview') {
    const P = spec.period;
    const ks = [['visitors', true], ['conversions', connected.goals], ['revenue', connected.sales], ['orders', connected.sales], ['roas', connected.ads]].filter(([, ok]) => ok)
      .map(([m]) => engine.query(site.id, { metric: m, period: P, tz, now }));
    const parts = ks.map((r) => `${words(r.metric, r.total, currency)}${r.change != null && r.previous ? ` (${r.change > 0 ? '+' : ''}${r.change}%)` : ''}`);
    const recs = engine.recommendations(site.id, { tz, currency, now }).filter((r) => r.tone !== 'setup');
    return { ...base, answer: `${cap(ks[0].period.label.replace(/^in the/, 'In the'))} you had ${listWords(parts)}, compared with ${ks[0].period.previousLabel}.${recs[0] ? ` The one thing I'd do next: ${recs[0].title.charAt(0).toLowerCase() + recs[0].title.slice(1)}. ${recs[0].why}` : ''}`,
      highlights: ks.map((r) => ({ label: cap(METRICS[r.metric].label), value: formatValue(r.metric, r.total, currency), tone: r.change == null ? 'neutral' : (r.change > 0) !== !!METRICS[r.metric].lowerIsBetter ? 'good' : r.change === 0 ? 'neutral' : 'bad', sub: r.change != null && r.previous ? `${r.change > 0 ? '+' : ''}${r.change}%` : '' })),
      nextSteps: recs.slice(0, 3), followUps: ['Why did visitors change?', 'Where do my visitors come from?', 'What should I do next?'] };
  }
  const r = engine.query(site.id, spec);
  const a = answerQuery({ ...r, sort: spec.sort }, { currency, countryNames, connected });
  return { ...base, ...a, evidence: a.setup ? null : evidenceOf(r, currency) };
}

function evidenceOf(r, currency) {
  if (!r || !r.rows) return null;
  if (r.by === 'none' || !r.rows.length) return null;
  return { metric: r.metric, metricLabel: r.metricLabel, unit: r.unit, by: r.by, byLabel: r.byLabel, period: r.period.label,
    series: ['day', 'week', 'month'].includes(r.by),
    rows: r.rows.slice(0, r.by === 'day' ? 400 : 12).map((x) => ({ label: x.label, value: x.value, display: formatValue(r.metric, x.value, currency), previous: x.previous ?? null })) };
}

// ---------------------------------------------------------------- Claude as the analyst (optional)
const TOOLS = [
  { name: 'query', description: 'Get one number, a ranking, or a trend from the business data. Use by="none" for a single total. Every result includes the same metric for the previous period of equal length, so you can say what changed.',
    input_schema: { type: 'object', properties: {
      metric: { type: 'string', enum: Object.keys(METRICS), description: 'visitors/pageviews/visits/bounce_rate/avg_duration come from the website; conversions/conversion_rate from tracked goals; revenue/orders/aov/revenue_per_visitor from sales; ad_spend/ad_clicks/roas/cpa from ad costs.' },
      by: { type: 'string', enum: DIMS, description: 'How to split the result. "none" for the total.' },
      period: { type: 'string', enum: PERIODS },
      filters: { type: 'object', description: 'Optional: narrow to one segment, e.g. {"device": "Mobile"} or {"channel": "Google"} or {"page": "/pricing"}.', properties: Object.fromEntries(DIMS.filter((d) => !TIME_DIMS.includes(d) && d !== 'none').map((d) => [d, { type: 'string' }])), additionalProperties: false },
      goal: { type: 'string', description: 'Optional: one goal name for conversions or conversion_rate.' },
      sort: { type: 'string', enum: ['desc', 'asc'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }, required: ['metric', 'by', 'period'] } },
  { name: 'explain_change', description: 'Explain why a metric went up or down compared with the previous period: returns the sources, landing pages, countries, devices and campaigns that moved it the most.',
    input_schema: { type: 'object', properties: { metric: { type: 'string', enum: Object.keys(METRICS) }, period: { type: 'string', enum: PERIODS.filter((p) => p !== 'all_time') }, filters: { type: 'object' } }, required: ['metric', 'period'] } },
  { name: 'recommendations', description: 'Data-backed next steps for this business, ranked by value: ads losing money, best sources, mobile problems, leaky landing pages, rising pages, missing setup.', input_schema: { type: 'object', properties: {} } },
  { name: 'respond', description: 'Give your final answer to the owner. Always finish by calling this exactly once.',
    input_schema: { type: 'object', properties: {
      answer: { type: 'string', description: 'The answer in plain, warm English: 2 to 5 sentences, numbers included, no markdown.' },
      highlights: { type: 'array', maxItems: 4, items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, tone: { type: 'string', enum: ['good', 'bad', 'neutral'] } }, required: ['label', 'value'] } },
      next_steps: { type: 'array', maxItems: 3, items: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' } }, required: ['title', 'why'] }, description: 'Only when there is something concrete to do.' },
      follow_ups: { type: 'array', maxItems: 3, items: { type: 'string' }, description: 'Short questions the owner might ask next.' },
    }, required: ['answer', 'follow_ups'] } },
];

async function askClaude(engine, site, question, o) {
  const local = new Date(Date.now() + o.tz * 60000).toISOString().slice(0, 16).replace('T', ' ');
  const system = `You are Dear Me, the analyst for ${site.domain}. The owner runs a small business and is not technical. You answer their questions from their own data using the tools: website traffic (cookie-free, privacy-first), goals they track, sales, and ad costs.

How to work:
- Call the tools to get every number you use. Never estimate, invent, or reuse numbers from memory. Use several calls when the question needs it (for example a total, then a breakdown, then explain_change).
- Prefer the period the owner names; otherwise use last_7_days for traffic and last_30_days for sales and ads.
- If the data needed is not connected, say so plainly and tell them how to connect it in Settings (sales: revenue on a Purchase goal, Stripe/Shopify/WooCommerce webhook, or CSV upload; ads: upload a daily cost report).
- When a result includes a note about approximate attribution, pass it on in one short sentence.
- Write like a trusted advisor talking to the owner: plain words, short sentences, the number first, then what it means, then what to do. No jargon (say "return on ad spend" not "ROAS" unless they used it), no markdown, no headings.
- Finish by calling respond exactly once.

Connected data: website ${o.connected.website ? 'yes' : 'no'}, goals ${o.connected.goals ? 'yes (' + o.known.goals.slice(0, 10).join(', ') + ')' : 'none yet'}, sales ${o.connected.sales ? 'yes' : 'no'}, ads ${o.connected.ads ? 'yes (' + o.known.channels.join(', ') + ')' : 'no'}. Currency: ${o.currency}. The owner's local time is ${local}.`;

  const messages = [];
  for (const h of (o.history || []).slice(-3)) {
    if (h.q && h.a) { messages.push({ role: 'user', content: String(h.q).slice(0, 500) }); messages.push({ role: 'assistant', content: String(h.a).slice(0, 1500) }); }
  }
  messages.push({ role: 'user', content: String(question).slice(0, 1000) });

  let evidence = null, final = null, lastText = '';
  for (let turn = 0; turn < 8 && !final; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify({ model: process.env.ANALYST_MODEL || 'claude-opus-5-5', max_tokens: 16000, output_config: { effort: process.env.ANALYST_EFFORT || 'low' },
        fallbacks: 'default', system, tools: TOOLS, tool_choice: { type: 'auto' }, messages }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const msg = await res.json();
    if (msg.stop_reason === 'refusal') return null;
    messages.push({ role: 'assistant', content: msg.content }); // keep every block (thinking included) unchanged
    lastText = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || lastText;
    const calls = msg.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) break;
    const results = [];
    for (const c of calls) {
      let out;
      try {
        const i = c.input || {};
        if (c.name === 'respond') { final = i; out = 'Delivered.'; }
        else if (c.name === 'query') { const r = engine.query(site.id, { ...i, tz: o.tz, now: o.now }); if (r.by !== 'none' && r.rows.length) evidence = evidenceOf(r, o.currency); out = JSON.stringify(slim(r)); }
        else if (c.name === 'explain_change') { const x = engine.explain(site.id, i.metric, i.period, { filters: cleanFilters(i.filters), tz: o.tz, now: o.now }); out = JSON.stringify({ ...slim(x), drivers: x.drivers, counter: x.counter, warnings: x.warnings }); }
        else if (c.name === 'recommendations') out = JSON.stringify(engine.recommendations(site.id, { tz: o.tz, currency: o.currency, now: o.now }));
        else out = 'Unknown tool';
        results.push({ type: 'tool_result', tool_use_id: c.id, content: out });
      } catch (e) { results.push({ type: 'tool_result', tool_use_id: c.id, content: 'Error: ' + e.message, is_error: true }); }
    }
    if (final) break;
    messages.push({ role: 'user', content: results });
  }
  const answer = final?.answer || lastText;
  if (!answer) return null;
  return { question, intent: 'ai', ai: true, answer, highlights: (final?.highlights || []).slice(0, 4), followUps: (final?.follow_ups || []).slice(0, 3),
    nextSteps: (final?.next_steps || []).map((s) => ({ title: s.title, why: s.why, tone: 'neutral' })), evidence };
}
function slim(r) {
  return { metric: r.metric, unit: r.unit, by: r.by, period: r.period.label, comparedWith: r.period.previousLabel, filters: r.filters, total: r.total, previous: r.previous, changePct: r.change,
    rows: r.rows?.slice(0, 31).map((x) => ({ key: x.label, value: x.value, previous: x.previous })), notes: r.notes };
}

module.exports = { createEngine, ask, parseQuestion, resolvePeriod, formatValue, METRICS, DIMS, PERIODS };
