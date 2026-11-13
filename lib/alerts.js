'use strict';
// Proactive alerts: every hour each site is checked for things an owner would want to hear about
// without asking: tracking that stopped, traffic or sales that fell or jumped, a conversion rate
// that slipped, ads that spend without selling, and new sources sending visitors.
// Each alert has a key, so the same event is only reported once.
const DAY = 864e5;
const localDay = (ts, tz) => new Date(ts + tz * 60000).toISOString().slice(0, 10);
const weekKey = (ts, tz) => { const d = new Date(localDay(ts, tz) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

function detect(db, engine, analyst, site, { now = Date.now(), tz = 0 } = {}) {
  const out = [];
  const add = (key, kind, severity, title, body) => out.push({ key, kind, severity, title, body });
  const cur = site.currency || 'USD';
  const money = (v) => analyst.formatValue('revenue', v, cur);
  const yday = localDay(now - DAY, tz);

  // 1. tracking went quiet
  const last = db.prepare('SELECT MAX(ts) t FROM events WHERE site_id = ?').get(site.id).t;
  if (last) {
    const perDay = db.prepare('SELECT COUNT(*) n FROM sessions WHERE site_id = ? AND start >= ?').get(site.id, now - 7 * DAY).n / 7;
    const quiet = now - last;
    if (perDay >= 20 && quiet >= 6 * 3600e3 && (perDay * quiet) / DAY >= 8) {
      const h = Math.round(quiet / 3600e3);
      add(`silent:${last}`, 'tracking', 'high', `No visitors recorded for ${h} hours`,
        `You usually get about ${Math.round(perDay)} visits a day, but nothing has arrived since ${new Date(last).toUTCString().slice(0, 22)} UTC. Check that the site is up and the tracking snippet is still on every page.`);
    }
  }

  // 2. yesterday's visitors against the same weekday in recent weeks
  const daily = new Map(engine.query(site.id, { metric: 'visitors', by: 'day', period: 'last_30_days', tz, now, compare: false }).rows.map((r) => [r.key, r.value]));
  const y = daily.get(yday);
  if (y != null) {
    const same = [7, 14, 21, 28].map((n) => daily.get(localDay(now - (n + 1) * DAY, tz))).filter((v) => v != null);
    const recent = [2, 3, 4, 5, 6, 7, 8].map((n) => daily.get(localDay(now - n * DAY, tz))).filter((v) => v != null);
    const pool = same.filter((v) => v > 0).length >= 3 ? same : recent;
    const base = pool.length ? pool.reduce((s, v) => s + v, 0) / pool.length : 0;
    if (base >= 30 && y <= base * 0.6) {
      const x = engine.explain(site.id, 'visitors', 'yesterday', { tz, now });
      const d = x.drivers[0];
      add(`traffic-drop:${yday}`, 'traffic', 'high', `Visitors fell ${Math.round((1 - y / base) * 100)}% yesterday`,
        `${y} visitors, against about ${Math.round(base)} on a normal day like it.${d ? ` The biggest drop was ${d.label} (${d.before} → ${d.now} ${analyst.METRICS[x.driverMetric].label}).` : ''}`);
    } else if (base >= 15 && y >= base * 1.6 && y - base >= 20) {
      const x = engine.explain(site.id, 'visitors', 'yesterday', { tz, now });
      const d = x.drivers.find((z) => z.dim === 'source') || x.drivers[0];
      add(`traffic-spike:${yday}`, 'traffic', 'good', `Visitors jumped ${Math.round((y / base - 1) * 100)}% yesterday`,
        `${y} visitors, against about ${Math.round(base)} normally.${d ? ` Most of the extra came from ${d.label} (${d.before} → ${d.now}).` : ''} Worth following up while people are paying attention.`);
    }
  }

  // 3. sales yesterday against the week before
  const sales = db.prepare('SELECT COUNT(*) n FROM orders WHERE site_id = ? AND ts >= ?').get(site.id, now - 9 * DAY).n;
  if (sales) {
    const rev = new Map(engine.query(site.id, { metric: 'revenue', by: 'day', period: 'last_14_days', tz, now, compare: false }).rows.map((r) => [r.key, r.value]));
    const ord = new Map(engine.query(site.id, { metric: 'orders', by: 'day', period: 'last_14_days', tz, now, compare: false }).rows.map((r) => [r.key, r.value]));
    const days = [2, 3, 4, 5, 6, 7, 8].map((n) => localDay(now - n * DAY, tz));
    const avgRev = days.reduce((s, d) => s + (rev.get(d) || 0), 0) / 7;
    const avgOrd = days.reduce((s, d) => s + (ord.get(d) || 0), 0) / 7;
    const yr = rev.get(yday) || 0;
    if (avgOrd >= 2 && yr <= avgRev * 0.5)
      add(`sales-drop:${yday}`, 'sales', 'high', `Sales were ${Math.round((1 - yr / avgRev) * 100)}% below normal yesterday`,
        `${money(yr)} from ${ord.get(yday) || 0} orders, against ${money(avgRev)} a day over the past week. If traffic was normal, check that checkout and payments are working.`);
    else if (avgOrd >= 1 && yr >= avgRev * 2 && yr - avgRev >= 50)
      add(`sales-spike:${yday}`, 'sales', 'good', `Your best sales day in a while`, `${money(yr)} yesterday, against ${money(avgRev)} a day over the past week.`);
  }

  // 4. conversion rate this week against last week
  const conv = engine.query(site.id, { metric: 'conversions', period: 'last_7_days', tz, now });
  if (conv.previous >= 20) {
    const rate = engine.query(site.id, { metric: 'conversion_rate', period: 'last_7_days', tz, now });
    if (rate.previous && rate.total <= rate.previous * 0.7)
      add(`conv-drop:${weekKey(now, tz)}`, 'conversion', 'medium', `Fewer visitors are converting`,
        `${rate.total}% of visitors converted in the last 7 days, down from ${rate.previous}% the week before. Something on the way to signing up or buying may be broken or slower.`);
  }

  // 5. ad campaigns spending without sales
  if (db.prepare('SELECT 1 FROM ad_spend WHERE site_id = ? AND day >= ? LIMIT 1').get(site.id, localDay(now - 8 * DAY, tz))) {
    const roas = new Map(engine.query(site.id, { metric: 'roas', by: 'campaign', period: 'last_7_days', tz, now, compare: false, limit: 50 }).rows.map((r) => [r.key, r.value]));
    for (const c of engine.query(site.id, { metric: 'ad_spend', by: 'campaign', period: 'last_7_days', tz, now, compare: false, limit: 50 }).rows) {
      if (c.key && c.value >= 50 && !(roas.get(c.key) > 0))
        add(`ad-waste:${c.key}:${weekKey(now, tz)}`, 'ads', 'medium', `"${c.label}" spent ${money(c.value)} with no sales`,
          `In the last 7 days this campaign cost ${money(c.value)} and no sale was matched to it. Pause it or check its links carry utm_campaign=${c.label}.`);
    }
  }

  // 6. a new source started sending visitors
  const off = tz * 60000, ys = Math.floor((now + off) / DAY) * DAY - off - DAY;
  for (const s of db.prepare(`SELECT source, COUNT(DISTINCT visitor) n FROM sessions WHERE site_id = ? AND start >= ? AND start < ? AND source IS NOT NULL AND source != 'Direct'
      AND source NOT IN (SELECT DISTINCT source FROM sessions WHERE site_id = ? AND start >= ? AND start < ? AND source IS NOT NULL)
      GROUP BY source HAVING n >= 15 ORDER BY n DESC LIMIT 3`).all(site.id, ys, ys + DAY, site.id, ys - 30 * DAY, ys)) {
    add(`new-source:${s.source}`, 'source', 'good', `New: ${s.source} sent ${s.n} visitors`, `${s.source} had never sent you visitors before yesterday. Find the post or link and join the conversation.`);
  }
  return out;
}

function save(db, siteId, list, now = Date.now()) {
  const st = db.prepare('INSERT OR IGNORE INTO alerts(site_id, created, key, kind, severity, title, body) VALUES(?, ?, ?, ?, ?, ?, ?)');
  const fresh = [];
  for (const a of list) if (st.run(siteId, now, a.key, a.kind, a.severity, a.title, a.body).changes) fresh.push(a);
  return fresh;
}

function alertEmailHtml(domain, alerts, url) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const color = { high: '#c8412f', medium: '#b7791f', good: '#1f8a4c' };
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:auto;color:#1c1d1f">
    <p style="color:#6b6f76;font-size:13px">Dear Me noticed something on <b>${esc(domain)}</b></p>
    ${alerts.map((a) => `<div style="border-left:4px solid ${color[a.severity] || '#5b5bd6'};padding:8px 14px;margin:12px 0;background:#f7f7f5;border-radius:6px">
      <div style="font-weight:700;font-size:16px">${esc(a.title)}</div><div style="margin-top:4px;line-height:1.5">${esc(a.body)}</div></div>`).join('')}
    ${url ? `<p><a href="${esc(url)}" style="background:#5b5bd6;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">Ask Dear Me about it</a></p>` : ''}
  </div>`;
}

module.exports = { detect, save, alertEmailHtml };
