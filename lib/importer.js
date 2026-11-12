'use strict';
// Import from Google Analytics: reads the CSV files GA4 (or old Universal Analytics) lets you download
// from any report (Share this report > Download File > CSV). One file = one report.
// Supported reports: Date / Day, Pages, Traffic source, Country, Browser, Operating system, Device category, Events.

const DIMENSIONS = [
  ['date', /^(date|day)$/i],
  ['page', /^(page path( and screen class)?|page|landing page( \+ query string)?|page path \+ query string)$/i],
  ['source', /^(session source|first user source|source|session source \/ medium|source \/ medium|session default channel group|default channel group|first user default channel group)$/i],
  ['country', /^country$/i],
  ['browser', /^browser$/i],
  ['os', /^operating system$/i],
  ['device', /^device category$/i],
  ['event', /^event name$/i],
];
const METRICS = {
  visitors: /^(active users|total users|users|new users)$/i,
  pageviews: /^(views|screen ?page ?views|pageviews|page views)$/i,
  visits: /^(sessions|engaged sessions)$/i,
  hits: /^(event count|total events)$/i,
};

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
const num = (s) => { const n = Number(String(s || '').replace(/[,\s%]/g, '')); return Number.isFinite(n) ? Math.round(n) : 0; };
const day = (s) => { const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(s).trim()); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };

function parseGaCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let start = null, end = null;
  for (const l of lines) {
    const m = /^#\s*(start|end) date:\s*(\d{8}|\d{4}-\d{2}-\d{2})/i.exec(l);
    if (m) { if (m[1].toLowerCase() === 'start') start = day(m[2]); else end = day(m[2]); }
  }
  // find the first header row with a dimension we know
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].startsWith('#')) continue;
    const head = parseCsvLine(lines[i]);
    const dimIdx = head.findIndex((h) => DIMENSIONS.some(([, re]) => re.test(h)));
    if (dimIdx < 0) continue;
    const dim = DIMENSIONS.find(([, re]) => re.test(head[dimIdx]))[0];
    const idx = Object.fromEntries(Object.entries(METRICS).map(([k, re]) => [k, head.findIndex((h) => re.test(h))]));
    if (Object.values(idx).every((v) => v < 0)) continue;
    const rows = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || l.startsWith('#')) break; // end of this table
      const cells = parseCsvLine(l);
      let key = cells[dimIdx];
      if (!key || /^(grand )?total$/i.test(key)) continue;
      if (dim === 'date') { key = day(key); if (!key) continue; }
      const r = { key, visitors: 0, pageviews: 0, visits: 0, hits: 0 };
      for (const [k, x] of Object.entries(idx)) if (x >= 0) r[k] = num(cells[x]);
      if (!r.visitors) r.visitors = r.visits || 0;
      rows.push(r);
    }
    if (!rows.length) continue;
    if (dim === 'date') { const ds = rows.map((r) => r.key).sort(); start = start || ds[0]; end = end || ds.at(-1); }
    if (!start || !end) throw new Error('This file has no date range. Download it from a GA report with dates in the header, or use the Date report.');
    return { dim, start, end, rows };
  }
  throw new Error('Could not find a supported Google Analytics report in this file. Try the Pages, Traffic acquisition, Country, Device or Date report, exported as CSV.');
}

// GA names -> the names this app uses, so imported and live data line up
const SOURCE_ALIASES = {
  google: 'Google', bing: 'Bing', duckduckgo: 'DuckDuckGo', yahoo: 'Yahoo', baidu: 'Baidu', yandex: 'Yandex', ecosia: 'Ecosia',
  '(direct)': 'Direct', direct: 'Direct', facebook: 'Facebook', 'm.facebook.com': 'Facebook', 'l.facebook.com': 'Facebook',
  instagram: 'Instagram', 't.co': 'X (Twitter)', twitter: 'X (Twitter)', 'x.com': 'X (Twitter)', linkedin: 'LinkedIn', 'lnkd.in': 'LinkedIn',
  reddit: 'Reddit', youtube: 'YouTube', tiktok: 'TikTok', pinterest: 'Pinterest', 'news.ycombinator.com': 'Hacker News',
  github: 'GitHub', 'github.com': 'GitHub', 'chatgpt.com': 'ChatGPT', chatgpt: 'ChatGPT', 'perplexity.ai': 'Perplexity', 'claude.ai': 'Claude',
};
let countryCodes = null;
function countryCode(name) {
  if (!countryCodes) {
    countryCodes = {};
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'region' });
      for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        try { const n = dn.of(code); if (n && n !== code) countryCodes[n.toLowerCase()] = code; } catch {}
      }
    } catch {}
    Object.assign(countryCodes, { 'united states': 'US', 'united kingdom': 'GB', 'south korea': 'KR', russia: 'RU', 'czechia': 'CZ', "côte d’ivoire": 'CI', "cote d'ivoire": 'CI', 'ivory coast': 'CI', vietnam: 'VN', 'hong kong': 'HK', taiwan: 'TW', '(not set)': null });
  }
  const k = String(name).toLowerCase();
  return k in countryCodes ? countryCodes[k] : null;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function normalizeKey(dim, key) {
  if (dim === 'source') {
    const base = String(key).split(' / ')[0].trim().toLowerCase();
    return SOURCE_ALIASES[base] || SOURCE_ALIASES[base.replace(/^www\./, '')] || (base === '(not set)' || base === '(none)' ? 'Direct' : key.split(' / ')[0]);
  }
  if (dim === 'country') return countryCode(key) || '(none)';
  if (dim === 'device') return cap(String(key).toLowerCase());
  if (dim === 'os') return /^ios$/i.test(key) ? 'iOS' : /mac/i.test(key) ? 'macOS' : /chrome ?os/i.test(key) ? 'ChromeOS' : key;
  if (dim === 'page') { try { return decodeURIComponent(String(key).split('?')[0]) || '/'; } catch { return String(key).split('?')[0] || '/'; } }
  return key;
}

module.exports = { parseGaCsv, normalizeKey };
