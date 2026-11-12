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
  siteByDomain: db.prepare('SELECT id, domain FROM sites WHERE domain = ?'),
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
  return {
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
}

function exportCsv(siteId, from, to) {
  const rows = db.prepare(`SELECT ts, name, path, source, utm_medium, utm_campaign, country, browser, os, device, props
      FROM events WHERE site_id = ? AND ts >= ? AND ts < ? ORDER BY ts`).all(siteId, from, to);
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = 'time,event,page,source,utm_medium,utm_campaign,country,browser,os,device,props';
  return [head, ...rows.map((r) => [new Date(r.ts).toISOString(), r.name, r.path, r.source, r.utm_medium, r.utm_campaign, r.country, r.browser, r.os, r.device, r.props].map(esc).join(','))].join('\n');
}

// ---------------------------------------------------------------- auth
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken() { const exp = Date.now() + 30 * 864e5; return `${exp}.${sign(String(exp))}`; }
function authed(req) {
  const m = /(?:^|;\s*)dm_auth=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const loginAttempts = new Map();
function checkPassword(pw, ip) {
  const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return 'locked';
  const x = crypto.createHash('sha256').update(String(pw)).digest();
  const y = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  const ok = crypto.timingSafeEqual(x, y);
  if (!ok) { a.n++; loginAttempts.set(ip, a); }
  return ok;
}

// ---------------------------------------------------------------- http
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
async function jsonBody(req) { try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; } }

function serveStatic(res, file, cache = 'no-cache') {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'Not found');
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(full).pipe(res);
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

function siteFor(req, params) {
  // logged-in admins can see any site; share links see one site read-only
  const token = params.get('share');
  if (token) return db.prepare('SELECT * FROM sites WHERE share_token = ?').get(token) || null;
  if (!authed(req)) return null;
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(+params.get('site')) || null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
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

    // --- auth
    if (p === '/api/login' && req.method === 'POST') {
      const { password } = await jsonBody(req);
      const ok = checkPassword(password || '', clientIp(req));
      if (ok === 'locked') return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      if (!ok) return send(res, 401, { error: 'Wrong password' });
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `dm_auth=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}` });
    }
    if (p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'dm_auth=; HttpOnly; Path=/; Max-Age=0' });
    if (p === '/api/me') {
      const token = url.searchParams.get('share');
      if (token) {
        const site = db.prepare('SELECT id, domain FROM sites WHERE share_token = ?').get(token);
        return site ? send(res, 200, { shared: true, sites: [site] }) : send(res, 404, { error: 'This link is no longer shared' });
      }
      return send(res, authed(req) ? 200 : 401, authed(req) ? { shared: false } : { error: 'login' });
    }

    // --- dashboard data
    if (p === '/api/stats') {
      const site = siteFor(req, url.searchParams);
      return site ? send(res, 200, stats(site.id, url.searchParams)) : send(res, 401, { error: 'login' });
    }
    if (p === '/api/live') {
      const site = siteFor(req, url.searchParams);
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
      const site = siteFor(req, url.searchParams);
      if (!site) return send(res, 401, 'login');
      const to = +url.searchParams.get('to') || Date.now();
      const from = +url.searchParams.get('from') || to - 30 * 864e5;
      return send(res, 200, exportCsv(site.id, from, to), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${site.domain}-analytics.csv"` });
    }

    // --- site management (admin only)
    if (p.startsWith('/api/sites')) {
      if (!authed(req)) return send(res, 401, { error: 'login' });
      const id = +p.split('/')[3] || 0;
      if (p === '/api/sites' && req.method === 'GET') {
        const sites = db.prepare(`SELECT s.id, s.domain, s.share_token,
            (SELECT COUNT(DISTINCT visitor) FROM events e WHERE e.site_id = s.id AND e.ts > ?) AS visitors24h,
            (SELECT MAX(ts) FROM events e WHERE e.site_id = s.id) AS lastSeen
            FROM sites s ORDER BY s.domain`).all(Date.now() - 864e5);
        return send(res, 200, { sites });
      }
      if (p === '/api/sites' && req.method === 'POST') {
        const domain = cleanDomain((await jsonBody(req)).domain);
        if (!/^[a-z0-9.-]+(:\d+)?$/.test(domain) || !domain.includes('.') && !domain.startsWith('localhost')) return send(res, 400, { error: 'Enter a domain like example.com' });
        if (q.siteByDomain.get(domain)) return send(res, 409, { error: 'That site is already added' });
        const r = db.prepare('INSERT INTO sites(domain, created) VALUES(?, ?)').run(domain, Date.now());
        return send(res, 201, { id: Number(r.lastInsertRowid), domain });
      }
      if (id && p.endsWith('/share') && req.method === 'POST') {
        const { on } = await jsonBody(req);
        const token = on ? crypto.randomBytes(12).toString('base64url') : null;
        db.prepare('UPDATE sites SET share_token = ? WHERE id = ?').run(token, id);
        return send(res, 200, { share_token: token });
      }
      if (id && req.method === 'DELETE') {
        db.exec('BEGIN');
        db.prepare('DELETE FROM events WHERE site_id = ?').run(id);
        db.prepare('DELETE FROM sessions WHERE site_id = ?').run(id);
        db.prepare('DELETE FROM sites WHERE id = ?').run(id);
        db.exec('COMMIT');
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // --- dashboard app
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      if (p === '/' || p.startsWith('/share/') || p.startsWith('/site/')) return serveStatic(res, 'index.html');
      return serveStatic(res, p.slice(1), 'public, max-age=300');
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});

// retention cleanup, once an hour
function cleanup() {
  if (!RETENTION_DAYS) return;
  const cutoff = Date.now() - RETENTION_DAYS * 864e5;
  db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM sessions WHERE last < ?').run(cutoff);
}
setInterval(cleanup, 3600e3).unref();
cleanup();

server.listen(PORT, () => console.log(`Dear Me Analytics running on http://localhost:${PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });

module.exports = { cleanDomain, sourceFrom };
