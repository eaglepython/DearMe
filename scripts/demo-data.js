#!/usr/bin/env node
// Fills the database with 90 days of realistic fake traffic for a "demo.example.com" site,
// so you can see the dashboard before any real visitors arrive.  Usage: npm run demo
'use strict';
process.removeAllListeners('warning');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
require('node:fs').mkdirSync(DATA_DIR, { recursive: true });
// make sure the schema exists by loading the server module's DB setup without listening
const db = new DatabaseSync(path.join(DATA_DIR, 'analytics.db'));
db.exec(`CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY, domain TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, share_token TEXT);
  CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, visitor TEXT NOT NULL, start INTEGER NOT NULL, last INTEGER NOT NULL,
    pageviews INTEGER NOT NULL DEFAULT 0, engaged INTEGER NOT NULL DEFAULT 0, entry TEXT, exit TEXT, source TEXT, utm_medium TEXT, utm_campaign TEXT,
    country TEXT, browser TEXT, os TEXT, device TEXT);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, session_id INTEGER NOT NULL, ts INTEGER NOT NULL, visitor TEXT NOT NULL,
    name TEXT NOT NULL, path TEXT, props TEXT, source TEXT, utm_medium TEXT, utm_campaign TEXT, country TEXT, browser TEXT, os TEXT, device TEXT);`);

const DOMAIN = process.argv[2] || 'demo.example.com';
let site = db.prepare('SELECT id FROM sites WHERE domain = ?').get(DOMAIN);
if (!site) site = { id: Number(db.prepare('INSERT INTO sites(domain, created) VALUES(?, ?)').run(DOMAIN, Date.now()).lastInsertRowid) };
db.prepare('DELETE FROM events WHERE site_id = ?').run(site.id);
db.prepare('DELETE FROM sessions WHERE site_id = ?').run(site.id);

const pick = (arr) => { const total = arr.reduce((s, [, w]) => s + w, 0); let r = Math.random() * total; for (const [v, w] of arr) { if ((r -= w) <= 0) return v; } return arr[0][0]; };
const PAGES = [['/', 40], ['/pricing', 14], ['/blog/privacy-first-analytics', 10], ['/features', 9], ['/blog/why-we-dropped-cookies', 7], ['/docs/getting-started', 6], ['/about', 4], ['/signup', 5], ['/contact', 3], ['/blog/gdpr-guide', 2]];
const SOURCES = [['Google', 38], ['Direct', 26], ['X (Twitter)', 7], ['Hacker News', 6], ['Reddit', 5], ['LinkedIn', 4], ['GitHub', 3], ['DuckDuckGo', 3], ['ChatGPT', 3], ['newsletter', 3], ['Bing', 2]];
const COUNTRIES = [['US', 30], ['FR', 10], ['GB', 9], ['DE', 8], ['CA', 6], ['IN', 6], ['NG', 4], ['BR', 4], ['NL', 3], ['ES', 3], ['JP', 2], ['AU', 2], ['CI', 2], ['SN', 1]];
const BROWSERS = [['Chrome', 58], ['Safari', 22], ['Firefox', 8], ['Edge', 8], ['Samsung Internet', 3], ['Opera', 1]];
const DEVICES = [['Desktop', 55], ['Mobile', 40], ['Tablet', 5]];

const insS = db.prepare(`INSERT INTO sessions(site_id, visitor, start, last, pageviews, engaged, entry, exit, source, utm_medium, utm_campaign, country, browser, os, device)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insE = db.prepare(`INSERT INTO events(site_id, session_id, ts, visitor, name, path, props, source, utm_medium, utm_campaign, country, browser, os, device)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

db.exec('BEGIN');
const now = Date.now();
let sessions = 0, events = 0;
for (let d = 90; d >= 0; d--) {
  const dayStart = new Date(now - d * 864e5); dayStart.setHours(0, 0, 0, 0);
  const weekday = dayStart.getDay();
  const growth = 1 + (90 - d) / 60; // traffic grows over time
  const spike = d === 12 ? 4 : d === 11 ? 2 : 1; // a Hacker News moment
  const n = Math.round((60 + Math.random() * 30) * growth * spike * (weekday === 0 || weekday === 6 ? 0.65 : 1));
  for (let i = 0; i < n; i++) {
    // hours weighted toward the afternoon
    const hour = Math.min(23, Math.max(0, Math.round(14 + (Math.random() + Math.random() + Math.random() - 1.5) * 8)));
    const start = dayStart.getTime() + hour * 3600e3 + Math.random() * 3600e3;
    if (start > now) continue;
    const visitor = Math.random().toString(36).slice(2, 12);
    const source = d === 12 && Math.random() < 0.6 ? 'Hacker News' : pick(SOURCES);
    const campaign = source === 'newsletter' ? 'november-launch' : null;
    const browser = pick(BROWSERS);
    const device = browser === 'Samsung Internet' ? 'Mobile' : pick(DEVICES);
    const os = device === 'Desktop' ? pick([['Windows', 50], ['macOS', 40], ['Linux', 10]]) : browser === 'Safari' ? 'iOS' : pick([['Android', 70], ['iOS', 30]]);
    const country = pick(COUNTRIES);
    const views = Math.random() < 0.42 ? 1 : 1 + Math.ceil(Math.random() * Math.random() * 7);
    let t = start, entry, exit;
    const r = insS.run(site.id, visitor, start, start, 0, 0, '', '', source, campaign ? 'email' : null, campaign, country, browser, os, device);
    const sid = Number(r.lastInsertRowid);
    for (let v = 0; v < views; v++) {
      const page = v === 0 && source === 'Hacker News' ? '/blog/privacy-first-analytics' : pick(PAGES);
      if (!entry) entry = page; exit = page;
      insE.run(site.id, sid, t, visitor, 'pageview', page, null, source, campaign ? 'email' : null, campaign, country, browser, os, device);
      events++;
      if (page === '/signup' && Math.random() < 0.45) { insE.run(site.id, sid, t + 20e3, visitor, 'Signup', page, JSON.stringify({ plan: pick([['free', 7], ['pro', 3]]) }), source, null, campaign, country, browser, os, device); events++; }
      if (page === '/docs/getting-started' && Math.random() < 0.3) { insE.run(site.id, sid, t + 15e3, visitor, 'Download', page, null, source, null, campaign, country, browser, os, device); events++; }
      if (v < views - 1) t += 15e3 + Math.random() * 120e3;
    }
    const engaged = views === 1 ? Math.round(5e3 + Math.random() * 40e3) : Math.round(t - start + 10e3 + Math.random() * 60e3);
    db.prepare('UPDATE sessions SET last = ?, pageviews = ?, engaged = ?, entry = ?, exit = ? WHERE id = ?').run(t, views, engaged, entry, exit, sid);
    sessions++;
  }
}
db.exec('COMMIT');
console.log(`Added ${sessions.toLocaleString()} visits and ${events.toLocaleString()} events for ${DOMAIN}.`);
