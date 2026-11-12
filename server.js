#!/usr/bin/env node
/*
 * Dear Me Analytics: privacy-first, cookie-free website analytics.
 * One file, zero npm dependencies. Needs Node 22.5+ (built-in node:sqlite).
 *
 *   ADMIN_PASSWORD=secret node server.js
 *
 * Env: PORT (3000), ADMIN_PASSWORD, DATA_DIR (./data), RETENTION_DAYS (0 = keep forever)
 */
'use strict';
process.removeAllListeners('warning'); // hide the node:sqlite "experimental" banner
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { countryFromTimezone, COUNTRY_NAMES } = require('./lib/geo');
const { parseUA, isBot } = require('./lib/ua');
const { computeFunnel, validateSteps } = require('./lib/funnels');
const insights = require('./lib/insights');
const mailer = require('./lib/mailer');
const billing = require('./lib/billing');
const { parseGaCsv, normalizeKey } = require('./lib/importer');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const RETENTION_DAYS = +process.env.RETENTION_DAYS || 0;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_GAP = 30 * 60 * 1000;
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(DATA_DIR, 'analytics.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY, domain TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, share_token TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, visitor TEXT NOT NULL,
    start INTEGER NOT NULL, last INTEGER NOT NULL, pageviews INTEGER NOT NULL DEFAULT 0,
    engaged INTEGER NOT NULL DEFAULT 0, entry TEXT, exit TEXT,
    source TEXT, utm_medium TEXT, utm_campaign TEXT, country TEXT, browser TEXT, os TEXT, device TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, session_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    visitor TEXT NOT NULL, name TEXT NOT NULL, path TEXT, props TEXT,
    source TEXT, utm_medium TEXT, utm_campaign TEXT, country TEXT, browser TEXT, os TEXT, device TEXT
  );
  CREATE INDEX IF NOT EXISTS ev_site_ts ON events(site_id, ts);
  CREATE INDEX IF NOT EXISTS se_site_start ON sessions(site_id, start);
  CREATE INDEX IF NOT EXISTS se_lookup ON sessions(site_id, visitor, last);
`);
// accounts (customers), their people, and the newer features
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, trial_ends INTEGER NOT NULL,
    plan TEXT, status TEXT, stripe_customer TEXT, stripe_subscription TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, email TEXT UNIQUE NOT NULL, name TEXT,
    pw_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY, account_id INTEGER NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS funnels (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, name TEXT NOT NULL, steps TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, created INTEGER NOT NULL, filename TEXT, dim TEXT NOT NULL,
    start_day TEXT NOT NULL, end_day TEXT NOT NULL, rows INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS imported (
    import_id INTEGER NOT NULL, site_id INTEGER NOT NULL, dim TEXT NOT NULL, key TEXT NOT NULL,
    start_day TEXT NOT NULL, end_day TEXT NOT NULL, visitors INTEGER, pageviews INTEGER, visits INTEGER, hits INTEGER
  );
  CREATE INDEX IF NOT EXISTS imp_site ON imported(site_id, dim, start_day);
`);
const siteCols = db.prepare('PRAGMA table_info(sites)').all().map((c) => c.name);
if (!siteCols.includes('account_id')) db.exec('ALTER TABLE sites ADD COLUMN account_id INTEGER');
if (!siteCols.includes('report_emails')) db.exec('ALTER TABLE sites ADD COLUMN report_emails TEXT');
// account 1 belongs to the operator (you); sites from before accounts existed move into it
if (!db.prepare('SELECT 1 FROM accounts WHERE id = 1').get())
  db.prepare('INSERT INTO accounts(id, name, created, trial_ends, plan, status) VALUES(1, ?, ?, ?, NULL, ?)').run('My sites', Date.now(), 4102444800000, 'operator');
db.exec('UPDATE sites SET account_id = 1 WHERE account_id IS NULL');

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
function setting(key, make) {
  const row = getSetting.get(key);
  if (row) return row.value;
  const v = make();
  setSetting.run(key, v);
  return v;
}
const SECRET = setting('secret', () => crypto.randomBytes(32).toString('hex'));

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = setting('generated_password', () => crypto.randomBytes(9).toString('base64url'));
  console.log(`\n  No ADMIN_PASSWORD set. Generated one for you: ${ADMIN_PASSWORD}\n  (set ADMIN_PASSWORD to choose your own)\n`);
}

// ---------------------------------------------------------------- privacy: daily rotating salt
// Visitors are counted with hash(salt + site + ip + user agent). The salt changes every day and
// old salts are deleted, so nobody (including you) can link a visitor across days or recover an IP.
let salt = { day: '', value: '' };
function dailySalt() {
  const day = new Date().toISOString().slice(0, 10);
  if (salt.day !== day) {
    const stored = getSetting.get('salt');
    const parsed = stored ? JSON.parse(stored.value) : null;
    salt = parsed && parsed.day === day ? parsed : { day, value: crypto.randomBytes(16).toString('hex') };
    setSetting.run('salt', JSON.stringify(salt));
  }
  return salt.value;
}
const visitorId = (siteId, ip, ua) =>
  crypto.createHash('sha256').update(`${dailySalt()}|${siteId}|${ip}|${ua}`).digest('base64url').slice(0, 16);

// ---------------------------------------------------------------- sources
const SOURCE_NAMES = [
  [/(^|\.)google\./, 'Google'], [/(^|\.)bing\.com$/, 'Bing'], [/duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)yahoo\./, 'Yahoo'], [/yandex\./, 'Yandex'], [/baidu\.com$/, 'Baidu'], [/ecosia\.org$/, 'Ecosia'],
  [/search\.brave\.com$/, 'Brave Search'], [/(^|\.)facebook\.com$|^fb\.me$|^l\.facebook\.com$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'], [/^t\.co$|(^|\.)twitter\.com$|(^|\.)x\.com$/, 'X (Twitter)'],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, 'LinkedIn'], [/(^|\.)reddit\.com$/, 'Reddit'], [/(^|\.)youtube\.com$|^youtu\.be$/, 'YouTube'],
  [/(^|\.)tiktok\.com$/, 'TikTok'], [/(^|\.)pinterest\./, 'Pinterest'], [/news\.ycombinator\.com$/, 'Hacker News'],
  [/(^|\.)github\.com$/, 'GitHub'], [/(^|\.)chatgpt\.com$|chat\.openai\.com$/, 'ChatGPT'], [/(^|\.)claude\.ai$/, 'Claude'],
  [/(^|\.)perplexity\.ai$/, 'Perplexity'], [/(^|\.)whatsapp\.com$/, 'WhatsApp'], [/(^|\.)telegram\.org$|^t\.me$/, 'Telegram'],
];
function sourceFrom(refHost, utmSource, siteDomain) {
  if (utmSource) return utmSource.slice(0, 100);
  if (!refHost) return 'Direct';
  const h = refHost.replace(/^www\./, '');
  if (h === siteDomain || h.endsWith('.' + siteDomain)) return 'Direct';
  for (const [re, name] of SOURCE_NAMES) if (re.test(h)) return name;
  return h;
}
const cleanDomain = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

// ---------------------------------------------------------------- ingest
const q = {
  siteByDomain: db.prepare('SELECT id, domain, account_id FROM sites WHERE domain = ?'),
  findSession: db.prepare('SELECT id, source, utm_medium, utm_campaign, country, browser, os, device FROM sessions WHERE site_id = ? AND visitor = ? AND last > ? ORDER BY last DESC LIMIT 1'),
  newSession: db.prepare(`INSERT INTO sessions(site_id, visitor, start, last, pageviews, entry, exit, source, utm_medium, utm_campaign, country, browser, os, device)
    VALUES(?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  touchPageview: db.prepare('UPDATE sessions SET last = ?, pageviews = pageviews + 1, exit = ? WHERE id = ?'),
  touchEvent: db.prepare('UPDATE sessions SET last = ? WHERE id = ?'),
  engage: db.prepare('UPDATE sessions SET engaged = engaged + ?, last = MAX(last, ?) WHERE id = ?'),
  insertEvent: db.prepare(`INSERT INTO events(site_id, session_id, ts, visitor, name, path, props, source, utm_medium, utm_campaign, country, browser, os, device)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
};

function ingest(body, req) {
  const ua = req.headers['user-agent'] || '';
  if (isBot(ua)) return;
  let url;
  try { url = new URL(String(body.u)); } catch { return; }
  const domain = cleanDomain(body.d || url.hostname);
  const site = q.siteByDomain.get(domain);
  if (!site) return;
  if (!accountAccepts(site.account_id)) return;

  const name = String(body.n || 'pageview').slice(0, 80);
  const now = Date.now();
  const ip = clientIp(req);
  const visitor = visitorId(site.id, ip, ua);
  const pathName = (decodeSafe(url.pathname) || '/').slice(0, 300);

  let refHost = '';
  try { if (body.r) refHost = new URL(String(body.r)).hostname.toLowerCase(); } catch {}
  const p = url.searchParams;
  const source = sourceFrom(refHost, p.get('utm_source') || p.get('ref') || p.get('source'), site.domain);
  const { browser, os } = parseUA(ua);
  const w = +body.w || 0;
  const device = !w ? 'Unknown' : w < 576 ? 'Mobile' : w < 992 ? 'Tablet' : 'Desktop';
  const country = countryHeader(req) || countryFromTimezone(String(body.tz || '')) || null;

  let s = q.findSession.get(site.id, visitor, now - SESSION_GAP);
  if (name === 'engagement') {
    if (s) q.engage.run(Math.min(Math.max(+body.e || 0, 0), SESSION_GAP), now, s.id);
    return;
  }
  if (!s) {
    const r = q.newSession.run(site.id, visitor, now, now, pathName, pathName, source,
      p.get('utm_medium')?.slice(0, 100) || null, p.get('utm_campaign')?.slice(0, 100) || null, country, browser, os, device);
    s = { id: Number(r.lastInsertRowid), source, utm_medium: p.get('utm_medium')?.slice(0, 100) || null,
      utm_campaign: p.get('utm_campaign')?.slice(0, 100) || null, country, browser, os, device };
  }
  if (name === 'pageview') q.touchPageview.run(now, pathName, s.id); else q.touchEvent.run(now, s.id);

  let props = null;
  if (body.p && typeof body.p === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(body.p).slice(0, 20)) o[String(k).slice(0, 60)] = String(v).slice(0, 200);
    props = JSON.stringify(o);
  }
  // events carry the session's attributes so every report can be filtered the same way
  q.insertEvent.run(site.id, s.id, now, visitor, name, pathName, props, s.source, s.utm_medium, s.utm_campaign, s.country, s.browser, s.os, s.device);
  live.emit(site.id);
}

function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || (xf ? xf.split(',')[0] : '') || req.socket.remoteAddress || '').trim();
}
function countryHeader(req) {
  const c = req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country-code'] || req.headers['fly-client-country'];
  return c && /^[A-Z]{2}$/i.test(c) && c.toUpperCase() !== 'XX' ? c.toUpperCase() : null;
}

// live update notifications (Server-Sent Events) so the dashboard ticks in real time
const live = {
  subs: new Map(),
  emit(siteId) { for (const res of this.subs.get(siteId) || []) res.write('data: hit\n\n'); },
};

// ---------------------------------------------------------------- stats
const DIMENSIONS = { page: 'path', source: 'source', country: 'country', browser: 'browser', os: 'os', device: 'device', event: 'name', campaign: 'utm_campaign', medium: 'utm_medium' };

function where(siteId, from, to, filters, table) {
  // table: 'e' (events) or 's' (sessions)
  const clauses = [`${table}.site_id = ?`, table === 'e' ? 'e.ts >= ? AND e.ts < ?' : 's.start >= ? AND s.start < ?'];
  const args = [siteId, from, to];
  for (const [dim, val] of Object.entries(filters)) {
    let col = DIMENSIONS[dim];
    if (!col) continue;
    if (table === 's') {
      if (dim === 'event') { clauses.push('s.id IN (SELECT session_id FROM events WHERE site_id = ? AND name = ?)'); args.push(siteId, val); continue; }
      if (dim === 'page') { clauses.push('s.id IN (SELECT session_id FROM events WHERE site_id = ? AND name = \'pageview\' AND path = ?)'); args.push(siteId, val); continue; }
    }
    if (val === '(none)') clauses.push(`${table}.${col} IS NULL`);
    else { clauses.push(`${table}.${col} = ?`); args.push(val); }
  }
  return { sql: clauses.join(' AND '), args };
}

function summary(siteId, from, to, filters) {
  const ew = where(siteId, from, to, filters, 'e');
  const sw = where(siteId, from, to, filters, 's');
  const e = db.prepare(`SELECT COUNT(DISTINCT e.visitor) AS visitors, SUM(e.name = 'pageview') AS pageviews FROM events e WHERE ${ew.sql}`).get(...ew.args);
  const s = db.prepare(`SELECT COUNT(*) AS sessions, SUM(s.pageviews <= 1) AS bounces,
      AVG(MAX(s.last - s.start, s.engaged)) AS duration FROM sessions s WHERE ${sw.sql}`).get(...sw.args);
  return {
    visitors: e.visitors || 0,
    pageviews: e.pageviews || 0,
    visits: s.sessions || 0,
    bounceRate: s.sessions ? Math.round((100 * (s.bounces || 0)) / s.sessions) : 0,
    duration: Math.round((s.duration || 0) / 1000),
    viewsPerVisit: s.sessions ? Math.round((10 * (e.pageviews || 0)) / s.sessions) / 10 : 0,
  };
}

function series(siteId, from, to, filters, bucket, tzOffsetMin) {
  const fmt = { hour: '%Y-%m-%d %H:00', day: '%Y-%m-%d', month: '%Y-%m' }[bucket] || '%Y-%m-%d';
  const ew = where(siteId, from, to, filters, 'e');
  const rows = db.prepare(`SELECT strftime('${fmt}', (e.ts + ?) / 1000, 'unixepoch') AS t,
      COUNT(DISTINCT e.visitor) AS visitors, SUM(e.name = 'pageview') AS pageviews
      FROM events e WHERE ${ew.sql} GROUP BY t ORDER BY t`).all(tzOffsetMin * 60000, ...ew.args);
  return rows;
}

function breakdown(siteId, from, to, filters, dim, limit = 10) {
  const col = DIMENSIONS[dim];
  if (dim === 'entry' || dim === 'exit') {
    const sw = where(siteId, from, to, filters, 's');
    return db.prepare(`SELECT s.${dim} AS key, COUNT(DISTINCT s.visitor) AS visitors, COUNT(*) AS visits,
        ROUND(100.0 * SUM(s.pageviews <= 1) / COUNT(*)) AS bounce
        FROM sessions s WHERE ${sw.sql} GROUP BY s.${dim} ORDER BY visitors DESC LIMIT ?`).all(...sw.args, limit);
  }
  const ew = where(siteId, from, to, filters, 'e');
  const nameClause = dim === 'event' ? "AND e.name != 'pageview'" : dim === 'page' ? "AND e.name = 'pageview'" : '';
  return db.prepare(`SELECT COALESCE(e.${col}, '(none)') AS key, COUNT(DISTINCT e.visitor) AS visitors, COUNT(*) AS hits
      FROM events e WHERE ${ew.sql} ${nameClause} GROUP BY key ORDER BY visitors DESC, hits DESC LIMIT ?`).all(...ew.args, limit);
}

function realtime(siteId) {
  return db.prepare('SELECT COUNT(DISTINCT visitor) AS n FROM events WHERE site_id = ? AND ts > ?').get(siteId, Date.now() - 5 * 60000).n;
}

function stats(siteId, params) {
  const now = Date.now();
  const to = Math.min(+params.get('to') || now, now + 60000);
  const from = +params.get('from') || to - 7 * 864e5;
  const bucket = params.get('bucket') || 'day';
  const tz = +params.get('tz') || 0; // minutes east of UTC
  const filters = {};
  for (const d of Object.keys(DIMENSIONS)) if (params.get(d)) filters[d] = params.get(d);
  const span = to - from;
  const limit = Math.min(+params.get('limit') || 10, 500);
  const countries = breakdown(siteId, from, to, filters, 'country', limit).map((r) => ({ ...r, name: COUNTRY_NAMES[r.key] || r.key }));
  const out = {
    range: { from, to, bucket },
    realtime: realtime(siteId),
    summary: summary(siteId, from, to, filters),
    previous: summary(siteId, +params.get('pfrom') || from - span, +params.get('pto') || from, filters),
    series: series(siteId, from, to, filters, bucket, tz),
    pages: breakdown(siteId, from, to, filters, 'page', limit),
    entry: breakdown(siteId, from, to, filters, 'entry', limit),
    exit: breakdown(siteId, from, to, filters, 'exit', limit),
    sources: breakdown(siteId, from, to, filters, 'source', limit),
    campaigns: breakdown(siteId, from, to, filters, 'campaign', limit),
    countries,
    browsers: breakdown(siteId, from, to, filters, 'browser', limit),
    os: breakdown(siteId, from, to, filters, 'os', limit),
    devices: breakdown(siteId, from, to, filters, 'device', limit),
    events: breakdown(siteId, from, to, filters, 'event', limit),
  };
  if (params.get('imported') !== '0' && !Object.keys(filters).length) mergeImported(siteId, out, from, to, tz, bucket, limit);
  return out;
}

// ---------------------------------------------------------------- imported Google Analytics data
function mergeImported(siteId, out, from, to, tz, bucket, limit) {
  const dayOf = (ts) => new Date(ts + tz * 60000).toISOString().slice(0, 10);
  const fromDay = dayOf(from), toDay = dayOf(to - 1);
  const daily = db.prepare(`SELECT key, SUM(visitors) v, SUM(pageviews) p, SUM(visits) s FROM imported
      WHERE site_id = ? AND dim = 'date' AND key >= ? AND key <= ? GROUP BY key`).all(siteId, fromDay, toDay);
  if (!daily.length && !db.prepare("SELECT 1 FROM imported WHERE site_id = ? AND dim != 'date' AND start_day >= ? AND end_day <= ? LIMIT 1").get(siteId, fromDay, toDay)) return;
  out.imported = true;
  for (const d of daily) {
    out.summary.visitors += d.v; out.summary.pageviews += d.p; out.summary.visits += d.s;
    if (bucket === 'hour') continue;
    const k = bucket === 'month' ? d.key.slice(0, 7) : d.key;
    let row = out.series.find((r) => r.t === k);
    if (!row) { row = { t: k, visitors: 0, pageviews: 0 }; out.series.push(row); }
    row.visitors += d.v; row.pageviews += d.p;
  }
  out.series.sort((a, b) => a.t.localeCompare(b.t));
  if (out.summary.visits) out.summary.viewsPerVisit = Math.round((10 * out.summary.pageviews) / out.summary.visits) / 10;
  const map = { page: 'pages', source: 'sources', country: 'countries', browser: 'browsers', os: 'os', device: 'devices', event: 'events' };
  for (const [dim, key] of Object.entries(map)) {
    const rows = db.prepare(`SELECT key, SUM(visitors) v, SUM(hits) h FROM imported WHERE site_id = ? AND dim = ? AND start_day >= ? AND end_day <= ? GROUP BY key`).all(siteId, dim, fromDay, toDay);
    if (!rows.length) continue;
    const list = out[key];
    for (const r of rows) {
      let row = list.find((x) => x.key === r.key);
      if (!row) { row = { key: r.key, visitors: 0, hits: 0 }; if (key === 'countries') row.name = COUNTRY_NAMES[r.key] || r.key; list.push(row); }
      row.visitors += r.v; row.hits = (row.hits || 0) + (r.h || r.v);
    }
    list.sort((a, b) => b.visitors - a.visitors);
    list.length = Math.min(list.length, limit);
  }
}

function exportCsv(siteId, from, to) {
  const rows = db.prepare(`SELECT ts, name, path, source, utm_medium, utm_campaign, country, browser, os, device, props
      FROM events WHERE site_id = ? AND ts >= ? AND ts < ? ORDER BY ts`).all(siteId, from, to);
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = 'time,event,page,source,utm_medium,utm_campaign,country,browser,os,device,props';
  return [head, ...rows.map((r) => [new Date(r.ts).toISOString(), r.name, r.path, r.source, r.utm_medium, r.utm_campaign, r.country, r.browser, r.os, r.device, r.props].map(esc).join(','))].join('\n');
}


// ---------------------------------------------------------------- accounts, people, sessions
const SIGNUP_OPEN = process.env.ALLOW_SIGNUP ? process.env.ALLOW_SIGNUP === 'true' : billing.billingEnabled();
const ROLES = ['owner', 'admin', 'viewer'];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(String(pw), salt, 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken(uid) { const exp = Date.now() + 30 * 864e5; return `${uid}.${exp}.${sign(`${uid}.${exp}`)}`; }
function cookieFor(req, uid) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `dm_auth=${makeToken(uid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`;
}

// who is making this request: { uid, operator, user, account, role } or null
function me(req) {
  const m = /(?:^|;\s*)dm_auth=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [uid, exp, sig] = m[1].split('.');
  if (!uid || !exp || !sig || +exp < Date.now()) return null;
  const good = sign(`${uid}.${exp}`);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (uid === '0') {
    return { uid: 0, operator: true, role: 'owner', user: { id: 0, name: 'Operator', email: 'admin' }, account: db.prepare('SELECT * FROM accounts WHERE id = 1').get() };
  }
  const user = db.prepare('SELECT id, account_id, email, name, role FROM users WHERE id = ?').get(+uid);
  if (!user) return null;
  return { uid: user.id, operator: false, role: user.role, user, account: db.prepare('SELECT * FROM accounts WHERE id = ?').get(user.account_id) };
}
const canManage = (who) => who && (who.role === 'owner' || who.role === 'admin');

const attempts = new Map();
function rateLimited(key, max = 10) {
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
  a.n++; attempts.set(key, a);
  return a.n > max;
}
function checkOperatorPassword(pw) {
  const x = crypto.createHash('sha256').update(String(pw)).digest();
  const y = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(x, y);
}

// pageviews this calendar month, per account (cached for a minute)
const usageCache = new Map();
function monthUsage(accountId) {
  const c = usageCache.get(accountId);
  if (c && Date.now() - c.t < 60000) return c.n;
  const d = new Date(); const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const n = db.prepare(`SELECT COUNT(*) n FROM events e JOIN sites s ON s.id = e.site_id
      WHERE s.account_id = ? AND e.name = 'pageview' AND e.ts >= ?`).get(accountId, monthStart).n;
  usageCache.set(accountId, { n, t: Date.now() });
  return n;
}
function accountAccepts(accountId) {
  if (accountId === 1) return true;
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  return !!acc && billing.acceptsEvents(acc, monthUsage(accountId));
}
function accountInfo(acc) {
  const usage = monthUsage(acc.id);
  const plan = acc.id === 1 ? { id: 'operator', name: 'Owner', pageviews: Infinity, sites: Infinity } : billing.planOf(acc);
  return {
    id: acc.id, name: acc.name, plan: plan.id, planName: plan.name,
    limit: Number.isFinite(plan.pageviews) ? plan.pageviews : null, siteLimit: Number.isFinite(plan.sites) ? plan.sites : null,
    usage, state: acc.id === 1 ? 'ok' : billing.accountState(acc, usage),
    trialEnds: plan.id === 'trial' ? acc.trial_ends : null, hasBilling: !!acc.stripe_customer,
  };
}

// ---------------------------------------------------------------- http helpers
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png' };
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, max = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function jsonBody(req, max) { try { return JSON.parse((await readBody(req, max)) || '{}'); } catch { return {}; } }
function serveStatic(res, file, cache = 'no-cache') {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'Not found');
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(full).pipe(res);
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const baseUrl = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

// a site the requester may see: by share link, or by belonging to their account
function siteFor(req, params, who = me(req)) {
  const token = params.get('share');
  if (token) return db.prepare('SELECT * FROM sites WHERE share_token = ?').get(token) || null;
  if (!who) return null;
  return db.prepare('SELECT * FROM sites WHERE id = ? AND account_id = ?').get(+params.get('site'), who.account.id) || null;
}
const ownSite = (who, id) => (who ? db.prepare('SELECT * FROM sites WHERE id = ? AND account_id = ?').get(id, who.account.id) : null);

// ---------------------------------------------------------------- insights + weekly report
async function siteInsights(site, { ai = true } = {}) {
  const facts = insights.buildFacts(stats, site.id);
  const list = insights.bullets(facts);
  let summary = null;
  if (ai && process.env.ANTHROPIC_API_KEY && facts.visitors.now) {
    const key = `ai:${site.id}:${new Date().toISOString().slice(0, 10)}`; // one AI summary per site per day
    const cached = getSetting.get(key);
    if (cached) summary = cached.value;
    else { summary = await insights.aiSummary(site.domain, facts); if (summary) setSetting.run(key, summary); }
  }
  return { facts, bullets: list, summary, ai: !!process.env.ANTHROPIC_API_KEY };
}
async function sendReport(site, origin) {
  const emails = String(site.report_emails || '').split(',').map((s) => s.trim()).filter(validEmail);
  if (!emails.length) throw Object.assign(new Error('Add at least one email address first'), { expose: true });
  const r = await siteInsights(site);
  await mailer.sendEmail({ to: emails, subject: `Your week on ${site.domain}: ${r.facts.visitors.now.toLocaleString()} visitors`,
    html: mailer.reportHtml({ domain: site.domain, ...r, dashboardUrl: origin ? `${origin}/site/${site.id}` : null }) });
  return emails.length;
}
const isoWeek = (d) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return `${t.getUTCFullYear()}-W${Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7)}`; };
async function weeklyReports() {
  if (!mailer.emailEnabled()) return;
  const now = new Date();
  if (now.getUTCDay() !== 1 || now.getUTCHours() < (+process.env.REPORT_HOUR_UTC || 8)) return; // Mondays
  const week = isoWeek(now);
  for (const site of db.prepare("SELECT * FROM sites WHERE report_emails IS NOT NULL AND report_emails != ''").all()) {
    const k = `report:${site.id}`;
    if (getSetting.get(k)?.value === week) continue;
    setSetting.run(k, week);
    try { await sendReport(site, process.env.PUBLIC_URL); } catch (e) { console.error(`Weekly report for ${site.domain} failed:`, e.message); }
  }
}

// ---------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const params = url.searchParams;
  const parts = p.split('/').filter(Boolean); // e.g. ['api','sites','3','funnels']
  try {
    // --- public: tracker + ingest
    if (p === '/script.js' || p === '/js/script.js') return serveStatic(res, 'script.js', 'public, max-age=3600');
    if (p === '/api/event') {
      if (req.method === 'OPTIONS') return send(res, 204, '', CORS);
      if (req.method !== 'POST') return send(res, 405, 'POST only', CORS);
      let body = {};
      try { body = JSON.parse(await readBody(req, 4096)); } catch {}
      ingest(body, req);
      return send(res, 202, 'ok', CORS);
    }
    if (p === '/health') return send(res, 200, { ok: true });
    if (p === '/api/config') {
      return send(res, 200, { signup: SIGNUP_OPEN, billing: billing.billingEnabled(), email: mailer.emailEnabled(), ai: !!process.env.ANTHROPIC_API_KEY,
        trialDays: billing.TRIAL_DAYS, plans: Object.entries(billing.PLANS).map(([id, pl]) => ({ id, name: pl.name, pageviews: pl.pageviews, price: pl.price, sites: pl.sites })) });
    }

    // --- Stripe webhook
    if (p === '/api/stripe/webhook' && req.method === 'POST') {
      const raw = await readBody(req, 512 * 1024);
      if (!billing.verifyWebhook(raw, req.headers['stripe-signature'])) return send(res, 400, 'bad signature');
      const ev = JSON.parse(raw), o = ev.data.object;
      if (ev.type === 'checkout.session.completed' && o.client_reference_id) {
        db.prepare('UPDATE accounts SET stripe_customer = ?, stripe_subscription = ?, plan = ?, status = ? WHERE id = ?')
          .run(o.customer, o.subscription, o.metadata?.plan || null, 'active', +o.client_reference_id);
      } else if (ev.type.startsWith('customer.subscription.')) {
        const plan = billing.planFromPrice(o.items?.data?.[0]?.price?.id) || o.metadata?.plan || null;
        const status = ev.type === 'customer.subscription.deleted' ? 'canceled' : o.status;
        db.prepare('UPDATE accounts SET plan = ?, status = ?, stripe_subscription = ? WHERE stripe_customer = ?').run(plan, status, o.id, o.customer);
      }
      usageCache.clear();
      return send(res, 200, { received: true });
    }

    // --- sign in, sign up, invites
    if (p === '/api/login' && req.method === 'POST') {
      const { email, password } = await jsonBody(req);
      if (rateLimited('login:' + clientIp(req))) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const e = String(email || '').trim().toLowerCase();
      if (!e || e === 'admin') {
        if (!checkOperatorPassword(password || '')) return send(res, 401, { error: 'Wrong email or password' });
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookieFor(req, 0) });
      }
      const u = db.prepare('SELECT * FROM users WHERE email = ?').get(e);
      if (!u || !verifyPassword(password || '', u.pw_hash)) return send(res, 401, { error: 'Wrong email or password' });
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieFor(req, u.id) });
    }
    if (p === '/api/signup' && req.method === 'POST') {
      if (!SIGNUP_OPEN) return send(res, 403, { error: 'Sign-ups are closed on this server' });
      if (rateLimited('signup:' + clientIp(req), 5)) return send(res, 429, { error: 'Too many sign-ups from here. Try again later.' });
      const { name, email, password, company } = await jsonBody(req);
      const e = String(email || '').trim().toLowerCase();
      if (!validEmail(e)) return send(res, 400, { error: 'Enter a valid email' });
      if (String(password || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters for your password' });
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(e)) return send(res, 409, { error: 'An account with this email already exists. Sign in instead.' });
      const now = Date.now();
      const acc = db.prepare('INSERT INTO accounts(name, created, trial_ends, status) VALUES(?, ?, ?, ?)')
        .run(String(company || name || e.split('@')[0]).slice(0, 80), now, now + billing.TRIAL_DAYS * 864e5, 'trial');
      const u = db.prepare('INSERT INTO users(account_id, email, name, pw_hash, role, created) VALUES(?, ?, ?, ?, ?, ?)')
        .run(Number(acc.lastInsertRowid), e, String(name || '').slice(0, 80) || null, hashPassword(password), 'owner', now);
      return send(res, 201, { ok: true }, { 'Set-Cookie': cookieFor(req, Number(u.lastInsertRowid)) });
    }
    if (p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'dm_auth=; HttpOnly; Path=/; Max-Age=0' });
    if (parts[0] === 'api' && parts[1] === 'invite' && parts[2]) {
      const inv = db.prepare('SELECT * FROM invites WHERE token = ? AND expires > ?').get(parts[2], Date.now());
      if (!inv) return send(res, 404, { error: 'This invite has expired or was already used' });
      const acc = db.prepare('SELECT name FROM accounts WHERE id = ?').get(inv.account_id);
      if (req.method === 'GET') return send(res, 200, { email: inv.email, account: acc?.name, role: inv.role });
      const { name, password } = await jsonBody(req);
      if (String(password || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters for your password' });
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(inv.email)) return send(res, 409, { error: 'This email already has an account. Sign in instead.' });
      const u = db.prepare('INSERT INTO users(account_id, email, name, pw_hash, role, created) VALUES(?, ?, ?, ?, ?, ?)')
        .run(inv.account_id, inv.email, String(name || '').slice(0, 80) || null, hashPassword(password), inv.role, Date.now());
      db.prepare('DELETE FROM invites WHERE token = ?').run(inv.token);
      return send(res, 201, { ok: true }, { 'Set-Cookie': cookieFor(req, Number(u.lastInsertRowid)) });
    }
    if (p === '/api/me') {
      const token = params.get('share');
      if (token) {
        const site = db.prepare('SELECT id, domain FROM sites WHERE share_token = ?').get(token);
        return site ? send(res, 200, { shared: true, sites: [site] }) : send(res, 404, { error: 'This link is no longer shared' });
      }
      const who = me(req);
      if (!who) return send(res, 401, { error: 'login' });
      return send(res, 200, { shared: false, operator: who.operator, user: { ...who.user, role: who.role }, account: accountInfo(who.account) });
    }

    // --- dashboard data (logged in, or a share link)
    if (p === '/api/stats') {
      const site = siteFor(req, params);
      return site ? send(res, 200, stats(site.id, params)) : send(res, 401, { error: 'login' });
    }
    if (p === '/api/insights') {
      const site = siteFor(req, params);
      return site ? send(res, 200, await siteInsights(site, { ai: params.get('ai') !== '0' })) : send(res, 401, { error: 'login' });
    }
    if (p === '/api/funnel') {
      const site = siteFor(req, params);
      if (!site) return send(res, 401, { error: 'login' });
      const f = db.prepare('SELECT * FROM funnels WHERE id = ? AND site_id = ?').get(+params.get('id'), site.id);
      if (!f) return send(res, 404, { error: 'Funnel not found' });
      const to = +params.get('to') || Date.now(), from = +params.get('from') || to - 30 * 864e5;
      return send(res, 200, { id: f.id, name: f.name, steps: computeFunnel(db, site.id, from, to, JSON.parse(f.steps)) });
    }
    if (p === '/api/live') {
      const site = siteFor(req, params);
      if (!site) return send(res, 401, 'login');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      if (!live.subs.has(site.id)) live.subs.set(site.id, new Set());
      live.subs.get(site.id).add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); live.subs.get(site.id)?.delete(res); });
      return;
    }
    if (p === '/api/export') {
      const site = siteFor(req, params);
      if (!site) return send(res, 401, 'login');
      const to = +params.get('to') || Date.now(), from = +params.get('from') || to - 30 * 864e5;
      return send(res, 200, exportCsv(site.id, from, to), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${site.domain}-analytics.csv"` });
    }

    // everything below needs a signed-in person
    if (p.startsWith('/api/')) {
      const who = me(req);
      if (!who) return send(res, 401, { error: 'login' });
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await jsonBody(req, p.endsWith('/imports') ? 8 * 1024 * 1024 : 64 * 1024) : {};

      // --- your own password
      if (p === '/api/account/password' && req.method === 'POST') {
        if (who.operator) return send(res, 400, { error: 'The operator password is set with ADMIN_PASSWORD on the server' });
        const u = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(who.uid);
        if (!verifyPassword(body.current || '', u.pw_hash)) return send(res, 401, { error: 'Your current password is not right' });
        if (String(body.password || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters' });
        db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPassword(body.password), who.uid);
        return send(res, 200, { ok: true });
      }

      // --- billing
      if (p === '/api/billing/checkout' && req.method === 'POST') {
        if (who.role !== 'owner' || who.account.id === 1) return send(res, 403, { error: 'Only the account owner can change the plan' });
        return send(res, 200, { url: await billing.checkoutUrl(who.account, String(body.plan), who.user.email, baseUrl(req)) });
      }
      if (p === '/api/billing/portal' && req.method === 'POST') {
        if (who.role !== 'owner') return send(res, 403, { error: 'Only the account owner can manage billing' });
        return send(res, 200, { url: await billing.portalUrl(who.account, baseUrl(req)) });
      }

      // --- team
      if (parts[1] === 'team') {
        if (!canManage(who)) return send(res, 403, { error: 'Only owners and admins can manage the team' });
        const accId = who.account.id;
        if (p === '/api/team' && req.method === 'GET') {
          return send(res, 200, {
            users: db.prepare('SELECT id, email, name, role, created FROM users WHERE account_id = ? ORDER BY created').all(accId),
            invites: db.prepare('SELECT token, email, role, created, expires FROM invites WHERE account_id = ? AND expires > ?').all(accId, Date.now()),
          });
        }
        if (p === '/api/team/invite' && req.method === 'POST') {
          const e = String(body.email || '').trim().toLowerCase();
          const role = ['admin', 'viewer'].includes(body.role) ? body.role : 'viewer';
          if (!validEmail(e)) return send(res, 400, { error: 'Enter a valid email' });
          if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(e)) return send(res, 409, { error: 'This person already has an account' });
          const token = crypto.randomBytes(18).toString('base64url');
          db.prepare('DELETE FROM invites WHERE account_id = ? AND email = ?').run(accId, e);
          db.prepare('INSERT INTO invites(token, account_id, email, role, created, expires) VALUES(?, ?, ?, ?, ?, ?)').run(token, accId, e, role, Date.now(), Date.now() + 7 * 864e5);
          const link = `${baseUrl(req)}/invite/${token}`;
          let emailed = false;
          if (mailer.emailEnabled()) {
            try {
              await mailer.sendEmail({ to: [e], subject: `${who.user.name || who.user.email} invited you to ${who.account.name} on Dear Me Analytics`,
                html: `<p>You've been invited to see website analytics for <b>${who.account.name.replace(/</g, '&lt;')}</b>.</p><p><a href="${link}">Accept the invite</a> (valid for 7 days)</p>` });
              emailed = true;
            } catch (err) { console.error('Invite email failed:', err.message); }
          }
          return send(res, 201, { link, emailed });
        }
        if (parts[2] === 'invites' && parts[3] && req.method === 'DELETE') {
          db.prepare('DELETE FROM invites WHERE token = ? AND account_id = ?').run(parts[3], accId);
          return send(res, 200, { ok: true });
        }
        if (parts[2] === 'users' && parts[3]) {
          const target = db.prepare('SELECT * FROM users WHERE id = ? AND account_id = ?').get(+parts[3], accId);
          if (!target) return send(res, 404, { error: 'Not found' });
          if (target.role === 'owner' && who.role !== 'owner') return send(res, 403, { error: 'Only an owner can change another owner' });
          const owners = db.prepare("SELECT COUNT(*) n FROM users WHERE account_id = ? AND role = 'owner'").get(accId).n;
          if (req.method === 'DELETE') {
            if (target.role === 'owner' && owners <= 1 && accId !== 1) return send(res, 400, { error: 'An account needs at least one owner' });
            db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
            return send(res, 200, { ok: true });
          }
          if (req.method === 'PATCH') {
            if (!ROLES.includes(body.role)) return send(res, 400, { error: 'Unknown role' });
            if (body.role === 'owner' && who.role !== 'owner') return send(res, 403, { error: 'Only an owner can make someone an owner' });
            if (target.role === 'owner' && body.role !== 'owner' && owners <= 1 && accId !== 1) return send(res, 400, { error: 'An account needs at least one owner' });
            db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, target.id);
            return send(res, 200, { ok: true });
          }
        }
        return send(res, 404, { error: 'Not found' });
      }

      // --- operator: every customer at a glance
      if (p === '/api/admin/accounts') {
        if (!who.operator) return send(res, 403, { error: 'Operator only' });
        const accounts = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM users u WHERE u.account_id = a.id) users,
            (SELECT COUNT(*) FROM sites s WHERE s.account_id = a.id) sites,
            (SELECT email FROM users u WHERE u.account_id = a.id AND u.role = 'owner' ORDER BY created LIMIT 1) owner
            FROM accounts a WHERE a.id != 1 ORDER BY a.created DESC`).all()
          .map((a) => ({ id: a.id, name: a.name, owner: a.owner, users: a.users, sites: a.sites, created: a.created, status: a.status, ...accountInfo(a),
            mrr: a.plan && billing.PLANS[a.plan] && a.status === 'active' ? billing.PLANS[a.plan].price : 0 }));
        return send(res, 200, { accounts, mrr: accounts.reduce((s, a) => s + a.mrr, 0), paying: accounts.filter((a) => a.mrr).length,
          trials: accounts.filter((a) => a.plan === 'trial' && a.state !== 'expired').length });
      }

      // --- sites
      if (parts[1] === 'sites') {
        const accId = who.account.id;
        if (p === '/api/sites' && req.method === 'GET') {
          const sites = db.prepare(`SELECT s.id, s.domain, s.share_token, s.report_emails,
              (SELECT COUNT(DISTINCT visitor) FROM events e WHERE e.site_id = s.id AND e.ts > ?) AS visitors24h,
              (SELECT MAX(ts) FROM events e WHERE e.site_id = s.id) AS lastSeen
              FROM sites s WHERE s.account_id = ? ORDER BY s.domain`).all(Date.now() - 864e5, accId);
          return send(res, 200, { sites, canManage: canManage(who) });
        }
        if (!canManage(who)) return send(res, 403, { error: 'Viewers can look but not change settings. Ask an owner or admin.' });
        if (p === '/api/sites' && req.method === 'POST') {
          const domain = cleanDomain(body.domain);
          if (!/^[a-z0-9.-]+(:\d+)?$/.test(domain) || (!domain.includes('.') && !domain.startsWith('localhost'))) return send(res, 400, { error: 'Enter a domain like example.com' });
          if (q.siteByDomain.get(domain)) return send(res, 409, { error: 'That site is already being tracked' });
          const info = accountInfo(who.account);
          const count = db.prepare('SELECT COUNT(*) n FROM sites WHERE account_id = ?').get(accId).n;
          if (info.siteLimit != null && count >= info.siteLimit) return send(res, 402, { error: `Your ${info.planName} plan includes ${info.siteLimit} websites. Upgrade to add more.` });
          const r = db.prepare('INSERT INTO sites(domain, created, account_id) VALUES(?, ?, ?)').run(domain, Date.now(), accId);
          return send(res, 201, { id: Number(r.lastInsertRowid), domain });
        }
        const site = ownSite(who, +parts[2]);
        if (!site) return send(res, 404, { error: 'Not found' });
        const sub = parts[3];
        if (!sub && req.method === 'DELETE') {
          db.exec('BEGIN');
          for (const t of ['events', 'sessions', 'funnels', 'imported', 'imports']) db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).run(site.id);
          db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
          db.exec('COMMIT');
          return send(res, 200, { ok: true });
        }
        if (sub === 'share' && req.method === 'POST') {
          const token = body.on ? crypto.randomBytes(12).toString('base64url') : null;
          db.prepare('UPDATE sites SET share_token = ? WHERE id = ?').run(token, site.id);
          return send(res, 200, { share_token: token });
        }
        if (sub === 'report') {
          if (req.method === 'PUT') {
            const emails = String(body.emails || '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
            const bad = emails.find((e) => !validEmail(e));
            if (bad) return send(res, 400, { error: `"${bad}" is not a valid email` });
            db.prepare('UPDATE sites SET report_emails = ? WHERE id = ?').run(emails.slice(0, 20).join(',') || null, site.id);
            return send(res, 200, { emails });
          }
          if (parts[4] === 'send' && req.method === 'POST') {
            const n = await sendReport(site, baseUrl(req));
            return send(res, 200, { sent: n });
          }
          if (parts[4] === 'preview' && req.method === 'GET') {
            const r = await siteInsights(site);
            return send(res, 200, mailer.reportHtml({ domain: site.domain, ...r, dashboardUrl: `${baseUrl(req)}/site/${site.id}` }), { 'Content-Type': 'text/html; charset=utf-8' });
          }
        }
        if (sub === 'funnels') {
          if (req.method === 'GET') return send(res, 200, { funnels: db.prepare('SELECT id, name, steps FROM funnels WHERE site_id = ? ORDER BY created').all(site.id).map((f) => ({ ...f, steps: JSON.parse(f.steps) })) });
          if (req.method === 'POST') {
            const steps = (body.steps || []).map((s) => ({ type: s.type, value: String(s.value || '').trim().slice(0, 200) }));
            const err = validateSteps(steps);
            if (err) return send(res, 400, { error: err });
            const name = String(body.name || '').trim().slice(0, 80) || steps.map((s) => s.value).join(' → ');
            const r = db.prepare('INSERT INTO funnels(site_id, name, steps, created) VALUES(?, ?, ?, ?)').run(site.id, name, JSON.stringify(steps), Date.now());
            return send(res, 201, { id: Number(r.lastInsertRowid) });
          }
          if (parts[4] && req.method === 'DELETE') {
            db.prepare('DELETE FROM funnels WHERE id = ? AND site_id = ?').run(+parts[4], site.id);
            return send(res, 200, { ok: true });
          }
        }
        if (sub === 'imports') {
          if (req.method === 'GET') return send(res, 200, { imports: db.prepare('SELECT * FROM imports WHERE site_id = ? ORDER BY created DESC').all(site.id) });
          if (req.method === 'POST') {
            let parsed;
            try { parsed = parseGaCsv(String(body.csv || '')); } catch (e) { return send(res, 400, { error: e.message }); }
            db.exec('BEGIN');
            const imp = db.prepare('INSERT INTO imports(site_id, created, filename, dim, start_day, end_day, rows) VALUES(?, ?, ?, ?, ?, ?, ?)')
              .run(site.id, Date.now(), String(body.filename || 'ga.csv').slice(0, 120), parsed.dim, parsed.start, parsed.end, parsed.rows.length);
            const ins = db.prepare('INSERT INTO imported(import_id, site_id, dim, key, start_day, end_day, visitors, pageviews, visits, hits) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            for (const r of parsed.rows) {
              const k = parsed.dim === 'date' ? r.key : normalizeKey(parsed.dim, r.key);
              ins.run(Number(imp.lastInsertRowid), site.id, parsed.dim, String(k).slice(0, 300), parsed.dim === 'date' ? r.key : parsed.start, parsed.dim === 'date' ? r.key : parsed.end, r.visitors, r.pageviews, r.visits, r.hits);
            }
            db.exec('COMMIT');
            return send(res, 201, { dim: parsed.dim, start: parsed.start, end: parsed.end, rows: parsed.rows.length });
          }
          if (parts[4] && req.method === 'DELETE') {
            db.prepare('DELETE FROM imported WHERE import_id = ? AND site_id = ?').run(+parts[4], site.id);
            db.prepare('DELETE FROM imports WHERE id = ? AND site_id = ?').run(+parts[4], site.id);
            return send(res, 200, { ok: true });
          }
        }
        return send(res, 404, { error: 'Not found' });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // --- pages
    if (req.method === 'GET') {
      if (p === '/') {
        if (SIGNUP_OPEN || process.env.SHOW_LANDING === 'true') return serveStatic(res, 'landing.html');
        res.writeHead(302, { Location: '/app' }); return res.end();
      }
      if (['app', 'site', 'share', 'invite', 'login', 'signup', 'admin', 'team', 'account'].includes(parts[0])) return serveStatic(res, 'index.html');
      return serveStatic(res, p.slice(1), 'public, max-age=300');
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.expose ? 400 : 500, { error: err.expose ? err.message : 'Server error' });
  }
});

// hourly housekeeping: retention + Monday reports
function hourly() {
  if (RETENTION_DAYS) {
    const cutoff = Date.now() - RETENTION_DAYS * 864e5;
    db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM sessions WHERE last < ?').run(cutoff);
  }
  weeklyReports().catch((e) => console.error(e));
}
setInterval(hourly, 3600e3).unref();
hourly();

server.listen(PORT, () => console.log(`Dear Me Analytics running on http://localhost:${PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });

module.exports = { cleanDomain, sourceFrom };
