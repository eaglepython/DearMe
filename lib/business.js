'use strict';
// Business data next to the website data: sales (orders) and ad spend.
// Orders arrive three ways: a goal with a revenue amount from the tracker, a webhook from a
// shop or payment provider (Stripe, Shopify, WooCommerce, or plain JSON), or a CSV upload.
// Ad spend arrives by CSV export from the ad platform or the same webhook.

function setup(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, ts INTEGER NOT NULL, amount REAL NOT NULL, currency TEXT,
      ref TEXT NOT NULL, origin TEXT NOT NULL, source TEXT, medium TEXT, campaign TEXT, page TEXT, country TEXT, device TEXT,
      UNIQUE(site_id, ref)
    );
    CREATE INDEX IF NOT EXISTS ord_site_ts ON orders(site_id, ts);
    CREATE TABLE IF NOT EXISTS ad_spend (
      id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, day TEXT NOT NULL, channel TEXT NOT NULL, campaign TEXT NOT NULL DEFAULT '',
      spend REAL NOT NULL DEFAULT 0, clicks INTEGER, impressions INTEGER,
      UNIQUE(site_id, day, channel, campaign)
    );
    CREATE INDEX IF NOT EXISTS ads_site_day ON ad_spend(site_id, day);
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, created INTEGER NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
      severity TEXT NOT NULL, title TEXT NOT NULL, body TEXT, seen INTEGER NOT NULL DEFAULT 0, emailed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(site_id, key)
    );
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, user_id INTEGER, created INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT, ai INTEGER NOT NULL DEFAULT 0
    );
  `);
  const cols = db.prepare('PRAGMA table_info(sites)').all().map((c) => c.name);
  if (!cols.includes('ingest_key')) db.exec('ALTER TABLE sites ADD COLUMN ingest_key TEXT');
  if (!cols.includes('currency')) db.exec('ALTER TABLE sites ADD COLUMN currency TEXT');
  if (!cols.includes('tz')) db.exec('ALTER TABLE sites ADD COLUMN tz INTEGER');
}

// ---------------------------------------------------------------- channels
// Group traffic sources and ad platforms into the same families so ad spend can be matched with sales.
const CHANNELS = [
  ['Google', /google|adwords|gclid|youtube|youtu\.be/],
  ['Meta', /facebook|^fb$|fb\.|instagram|^ig$|meta/],
  ['TikTok', /tiktok/],
  ['LinkedIn', /linkedin|lnkd/],
  ['Microsoft', /bing|microsoft|msn/],
  ['X', /twitter|^x$|x \(twitter\)|^t\.co$/],
  ['Pinterest', /pinterest/],
  ['Reddit', /reddit/],
  ['Snapchat', /snapchat/],
  ['Email', /email|newsletter|mailchimp|klaviyo|sendgrid|substack/],
];
function channelOf(source) {
  const s = String(source || '').toLowerCase().trim();
  if (!s || s === 'direct' || s === '(none)') return 'Direct';
  for (const [name, re] of CHANNELS) if (re.test(s)) return name;
  return 'Other';
}
const PAID_MEDIUM = /^(cpc|ppc|paid|paidsocial|paid_social|paid-social|cpm|display|ads?|social_paid|paidsearch|paid_search|paid-search)$/i;
const isPaid = (medium, campaign) => PAID_MEDIUM.test(String(medium || '')) || (!!campaign && !/email|newsletter/i.test(String(medium || '')));

// ---------------------------------------------------------------- parsing helpers
function money(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim().replace(/[^\d.,\-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const comma = s.lastIndexOf(','), dot = s.lastIndexOf('.');
  if (comma > -1 && dot > -1) s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (comma > -1) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function toTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // unix seconds or ms
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return +s * 1000;
  if (/^\d{13}$/.test(s)) return +s;
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s); // GA style 20261110
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], 12);
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], 12); // a bare day counts as midday UTC
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/.exec(s); // 11/10/2026 (US) or 10.11.2026 (EU, when the first number is > 12)
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3]; if (y < 100) y += 2000;
    const [mo, d] = a > 12 ? [b, a] : s.includes('.') ? [b, a] : [a, b];
    return Date.UTC(y, mo - 1, d, 12);
  }
  m = /^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/i.exec(s); // Nov 10, 2026
  if (m && MONTHS[m[1].toLowerCase()] != null) return Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2], 12);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const src = String(text).replace(/^﻿/, '');
  const delim = (() => { const first = src.split('\n')[0] || ''; return (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ','; })();
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
// Finds the header row (exports often start with a title and a date range) and maps column names.
function table(text, wanted) {
  const rows = parseCsv(text);
  for (let h = 0; h < Math.min(rows.length, 12); h++) {
    const head = rows[h].map((c) => c.trim().toLowerCase());
    const idx = {};
    for (const [key, patterns] of Object.entries(wanted)) {
      const i = head.findIndex((c) => patterns.some((p) => (p instanceof RegExp ? p.test(c) : c === p)));
      if (i > -1) idx[key] = i;
    }
    if (idx.date != null && (idx.amount != null || idx.spend != null)) return { idx, rows: rows.slice(h + 1) };
  }
  return null;
}
const err = (m) => Object.assign(new Error(m), { expose: true });

function parseOrdersCsv(text) {
  const t = table(text, {
    date: ['date', 'day', 'created', 'created at', 'created_at', 'order date', 'paid at', 'time', 'timestamp', /^date/],
    amount: ['amount', 'total', 'revenue', 'value', 'price', 'sales', 'gross sales', 'net sales', 'order total', 'subtotal', /^total/, /amount/],
    id: ['id', 'order', 'order id', 'order_id', 'name', 'order number', 'number', 'transaction id', 'invoice'],
    currency: ['currency'],
    source: ['source', 'utm_source', 'utm source', 'channel', 'referrer', 'referring site'],
    medium: ['medium', 'utm_medium', 'utm medium'],
    campaign: ['campaign', 'utm_campaign', 'utm campaign'],
  });
  if (!t) throw err('Could not find a date column and an amount (or total) column in this file.');
  const out = [];
  t.rows.forEach((r, n) => {
    const ts = toTs(r[t.idx.date]); const amount = money(r[t.idx.amount]);
    if (ts == null || amount == null) return;
    out.push({ ts, amount, currency: t.idx.currency != null ? r[t.idx.currency]?.trim().toUpperCase() || null : null,
      ref: t.idx.id != null && r[t.idx.id]?.trim() ? 'order:' + r[t.idx.id].trim().replace(/^#/, '') : `csv:${dayOf(ts)}:${n}:${amount}`,
      source: t.idx.source != null ? r[t.idx.source]?.trim() || null : null,
      medium: t.idx.medium != null ? r[t.idx.medium]?.trim() || null : null,
      campaign: t.idx.campaign != null ? r[t.idx.campaign]?.trim() || null : null });
  });
  if (!out.length) throw err('No rows with a date and an amount were found.');
  return out;
}

// Google Ads, Meta Ads Manager, TikTok, LinkedIn and Microsoft Ads exports all fit this shape.
function parseAdsCsv(text, channel) {
  const t = table(text, {
    date: ['day', 'date', 'reporting starts', 'reporting start', 'start date', 'by day', /^date/, /^day/],
    spend: ['cost', 'spend', 'amount spent', 'amount', /^amount spent/, /^cost/, /^spend/, 'total spent'],
    campaign: ['campaign', 'campaign name', 'campaign_name', /^campaign/],
    clicks: ['clicks', 'link clicks', 'clicks (all)', /^clicks/],
    impressions: ['impressions', 'impr.', 'impr', /^impressions/],
    channel: ['channel', 'platform', 'network', 'source'],
  });
  if (!t) throw err('Could not find a day (or date) column and a cost (or spend) column in this file.');
  const agg = new Map();
  for (const r of t.rows) {
    const ts = toTs(r[t.idx.date]); const spend = money(r[t.idx.spend]);
    if (ts == null || spend == null) continue; // skips "Total" rows
    const ch = cleanChannel((t.idx.channel != null && r[t.idx.channel]?.trim()) || channel);
    const campaign = (t.idx.campaign != null ? r[t.idx.campaign] : '')?.trim().slice(0, 150) || '';
    const k = `${dayOf(ts)}|${ch}|${campaign}`;
    const a = agg.get(k) || { day: dayOf(ts), channel: ch, campaign, spend: 0, clicks: null, impressions: null };
    a.spend += spend;
    const c = t.idx.clicks != null ? money(r[t.idx.clicks]) : null; if (c != null) a.clicks = (a.clicks || 0) + Math.round(c);
    const im = t.idx.impressions != null ? money(r[t.idx.impressions]) : null; if (im != null) a.impressions = (a.impressions || 0) + Math.round(im);
    agg.set(k, a);
  }
  if (!agg.size) throw err('No rows with a day and a cost were found.');
  return [...agg.values()];
}
function cleanChannel(c) {
  const fam = channelOf(c);
  return fam === 'Other' || fam === 'Direct' ? String(c || 'Ads').trim().slice(0, 60) || 'Ads' : fam;
}

// ---------------------------------------------------------------- webhooks
// Returns { orders: [...], ads: [...] } from whatever a shop or payment provider sent.
function fromWebhook(body, sourceFrom) {
  const orders = [], ads = [];
  const utm = (url) => { try { const u = new URL(String(url), 'https://x.invalid'); return { source: u.searchParams.get('utm_source'), medium: u.searchParams.get('utm_medium'), campaign: u.searchParams.get('utm_campaign') }; } catch { return {}; } };
  const refHost = (url) => { try { return url ? new URL(String(url)).hostname.toLowerCase() : ''; } catch { return ''; } };

  // Stripe events
  if (body && typeof body.type === 'string' && body.data?.object) {
    const o = body.data.object, md = o.metadata || {};
    const base = { currency: o.currency?.toUpperCase() || null, source: md.utm_source || md.source || null, medium: md.utm_medium || null, campaign: md.utm_campaign || md.campaign || null };
    if (body.type === 'checkout.session.completed' && o.mode !== 'subscription' && o.payment_status !== 'unpaid')
      orders.push({ ...base, ts: toTs(o.created) || Date.now(), amount: (o.amount_total || 0) / 100, ref: 'order:' + o.id });
    else if (body.type === 'invoice.paid' && o.amount_paid > 0)
      orders.push({ ...base, ts: toTs(o.status_transitions?.paid_at || o.created) || Date.now(), amount: o.amount_paid / 100, ref: 'order:' + o.id });
    else if (body.type === 'charge.refunded' && o.amount_refunded > 0)
      orders.push({ ...base, ts: Date.now(), amount: -o.amount_refunded / 100, ref: 'stripe-refund:' + o.id + ':' + o.amount_refunded });
    return { orders, ads, provider: 'Stripe' };
  }
  // Shopify order
  if (body && body.total_price != null && (body.line_items || body.order_number || body.admin_graphql_api_id)) {
    const u = utm(body.landing_site || '');
    const ts = toTs(body.processed_at || body.created_at) || Date.now();
    orders.push({ ts, amount: money(body.current_total_price ?? body.total_price) || 0, currency: body.currency || null, ref: 'order:' + body.id,
      source: u.source || (body.referring_site ? sourceFrom(refHost(body.referring_site), null, '') : null), medium: u.medium, campaign: u.campaign });
    return { orders, ads, provider: 'Shopify' };
  }
  // WooCommerce order
  if (body && body.total != null && body.line_items && (body.date_created || body.date_created_gmt)) {
    const meta = Object.fromEntries((body.meta_data || []).map((m) => [String(m.key).replace(/^_?(wc_order_attribution_)?/, ''), m.value]));
    const ts = toTs(body.date_paid_gmt ? body.date_paid_gmt + 'Z' : body.date_created_gmt ? body.date_created_gmt + 'Z' : body.date_created) || Date.now();
    orders.push({ ts, amount: money(body.total) || 0, currency: body.currency || null, ref: 'order:' + body.id,
      source: meta.utm_source || meta.source || null, medium: meta.utm_medium || null, campaign: meta.utm_campaign || null });
    return { orders, ads, provider: 'WooCommerce' };
  }
  // Plain JSON: one order, a list, or { orders: [...], ad_spend: [...] }
  const list = Array.isArray(body) ? body : body?.orders || body?.sales || (body && (body.amount ?? body.revenue ?? body.total ?? body.value) != null ? [body] : []);
  for (const o of list) {
    const amount = money(o.amount ?? o.revenue ?? o.total ?? o.value);
    if (amount == null) continue;
    const ts = toTs(o.time ?? o.ts ?? o.date ?? o.created_at ?? o.created) || Date.now();
    const id = o.id ?? o.order_id ?? o.orderId ?? o.ref;
    orders.push({ ts, amount, currency: o.currency ? String(o.currency).toUpperCase() : null, ref: id != null ? 'order:' + id : `api:${ts}:${amount}`,
      source: o.source ?? o.utm_source ?? null, medium: o.medium ?? o.utm_medium ?? null, campaign: o.campaign ?? o.utm_campaign ?? null });
  }
  for (const a of body?.ad_spend || body?.ads || []) {
    const ts = toTs(a.day ?? a.date); const spend = money(a.spend ?? a.cost ?? a.amount);
    if (ts == null || spend == null) continue;
    ads.push({ day: dayOf(ts), channel: cleanChannel(a.channel || a.platform || 'Ads'), campaign: String(a.campaign || '').slice(0, 150), spend,
      clicks: a.clicks != null ? Math.round(money(a.clicks) || 0) : null, impressions: a.impressions != null ? Math.round(money(a.impressions) || 0) : null });
  }
  return { orders, ads, provider: 'API' };
}

// ---------------------------------------------------------------- writes
function saveOrders(db, siteId, origin, orders) {
  const st = db.prepare(`INSERT INTO orders(site_id, ts, amount, currency, ref, origin, source, medium, campaign, page, country, device)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, ref) DO UPDATE SET
      amount = CASE WHEN excluded.origin = 'tracker' THEN orders.amount ELSE excluded.amount END,
      currency = COALESCE(orders.currency, excluded.currency),
      source = CASE WHEN excluded.origin = 'tracker' OR orders.source IS NULL THEN excluded.source ELSE orders.source END,
      medium = CASE WHEN excluded.origin = 'tracker' OR orders.medium IS NULL THEN excluded.medium ELSE orders.medium END,
      campaign = CASE WHEN excluded.origin = 'tracker' OR orders.campaign IS NULL THEN excluded.campaign ELSE orders.campaign END,
      page = COALESCE(excluded.page, orders.page), country = COALESCE(excluded.country, orders.country), device = COALESCE(excluded.device, orders.device)`);
  const s = (v, n = 150) => (v == null || v === '' ? null : String(v).slice(0, n));
  for (const o of orders) {
    st.run(siteId, o.ts, Math.round(o.amount * 100) / 100, s(o.currency, 3), String(o.ref).slice(0, 200), origin, s(o.source, 100), s(o.medium, 100), s(o.campaign), s(o.page, 300), s(o.country, 2), s(o.device, 20));
  }
  return orders.length;
}
function saveAds(db, siteId, ads) {
  const st = db.prepare(`INSERT INTO ad_spend(site_id, day, channel, campaign, spend, clicks, impressions) VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, day, channel, campaign) DO UPDATE SET spend = excluded.spend, clicks = excluded.clicks, impressions = excluded.impressions`);
  for (const a of ads) st.run(siteId, a.day, a.channel, a.campaign || '', Math.round(a.spend * 100) / 100, a.clicks, a.impressions);
  return ads.length;
}

// What is connected, for the UI and for the analyst.
function dataSummary(db, siteId) {
  const o = db.prepare(`SELECT COUNT(*) n, SUM(amount) total, MIN(ts) first, MAX(ts) last,
      SUM(origin = 'tracker') tracker, SUM(origin = 'webhook') webhook, SUM(origin = 'csv') csv FROM orders WHERE site_id = ?`).get(siteId);
  const ads = db.prepare('SELECT channel, SUM(spend) spend, MIN(day) first, MAX(day) last, COUNT(DISTINCT campaign) campaigns FROM ad_spend WHERE site_id = ? GROUP BY channel ORDER BY spend DESC').all(siteId);
  const goals = db.prepare("SELECT name, COUNT(*) n FROM events WHERE site_id = ? AND name NOT IN ('pageview', 'engagement') AND ts > ? GROUP BY name ORDER BY n DESC LIMIT 20").all(siteId, Date.now() - 90 * 864e5);
  return {
    sales: { orders: o.n || 0, revenue: Math.round((o.total || 0) * 100) / 100, first: o.first, last: o.last, viaTracker: o.tracker || 0, viaWebhook: o.webhook || 0, viaCsv: o.csv || 0 },
    ads: ads.map((a) => ({ channel: a.channel, spend: Math.round(a.spend * 100) / 100, first: a.first, last: a.last, campaigns: a.campaigns })),
    goals: goals.map((g) => g.name),
  };
}

module.exports = { setup, channelOf, isPaid, money, toTs, parseCsv, parseOrdersCsv, parseAdsCsv, fromWebhook, saveOrders, saveAds, dataSummary, cleanChannel };
