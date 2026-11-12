'use strict';
// End-to-end test: start the server on a temp DB, add a site, send events, read stats.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3999 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
let proc, dir, cookie;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_PASSWORD: 'pw' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const hit = (body, headers = {}) => fetch(BASE + '/api/event', { method: 'POST', body: JSON.stringify(body), headers: { 'User-Agent': UA, 'Content-Type': 'text/plain', ...headers } });

test('rejects wrong password, accepts right one', async () => {
  assert.equal((await fetch(BASE + '/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) })).status, 401);
  const r = await fetch(BASE + '/api/login', { method: 'POST', body: JSON.stringify({ password: 'pw' }) });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});

test('stats require login', async () => {
  assert.equal((await fetch(BASE + '/api/stats?site=1')).status, 401);
});

test('counts visitors without cookies and splits sources', async () => {
  const r = await fetch(BASE + '/api/sites', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ domain: 'https://www.Example.com/' }) });
  assert.equal(r.status, 201);
  const site = await r.json();
  assert.equal(site.domain, 'example.com');

  const a = { 'X-Forwarded-For': '1.1.1.1' }, b = { 'X-Forwarded-For': '2.2.2.2' };
  await hit({ n: 'pageview', u: 'https://example.com/?utm_source=newsletter', d: 'example.com', w: 1400, tz: 'Europe/Paris' }, a);
  await hit({ n: 'pageview', u: 'https://example.com/pricing', d: 'example.com', r: 'https://example.com/', w: 1400, tz: 'Europe/Paris' }, a);
  await hit({ n: 'Signup', u: 'https://example.com/pricing', d: 'example.com', p: { plan: 'pro' }, w: 1400 }, a);
  await hit({ n: 'pageview', u: 'https://example.com/', d: 'example.com', r: 'https://www.google.com/', w: 390, tz: 'Africa/Abidjan' }, b);
  await hit({ n: 'engagement', u: 'https://example.com/', d: 'example.com', e: 12000 }, b);
  // ignored: bots, unknown sites
  await hit({ n: 'pageview', u: 'https://example.com/', d: 'example.com' }, { 'User-Agent': 'Googlebot/2.1', 'X-Forwarded-For': '3.3.3.3' });
  await hit({ n: 'pageview', u: 'https://other.com/', d: 'other.com' }, { 'X-Forwarded-For': '4.4.4.4' });

  const s = await (await fetch(`${BASE}/api/stats?site=${site.id}&from=${Date.now() - 864e5}&to=${Date.now() + 1000}`, { headers: { Cookie: cookie } })).json();
  assert.equal(s.summary.visitors, 2);
  assert.equal(s.summary.pageviews, 3);
  assert.equal(s.summary.visits, 2);
  assert.equal(s.summary.bounceRate, 50);
  assert.deepEqual(s.sources.map((x) => x.key).sort(), ['Google', 'newsletter']);
  assert.deepEqual(s.countries.map((x) => x.key).sort(), ['CI', 'FR']);
  assert.deepEqual(s.devices.map((x) => x.key).sort(), ['Desktop', 'Mobile']);
  assert.equal(s.events[0].key, 'Signup');
  assert.equal(s.realtime, 2);

  // filter by source
  const f = await (await fetch(`${BASE}/api/stats?site=${site.id}&from=${Date.now() - 864e5}&source=Google`, { headers: { Cookie: cookie } })).json();
  assert.equal(f.summary.visitors, 1);
  assert.equal(f.summary.bounceRate, 100);

  // share link
  const sh = await (await fetch(`${BASE}/api/sites/${site.id}/share`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ on: true }) })).json();
  const pub = await fetch(`${BASE}/api/stats?share=${sh.share_token}&from=${Date.now() - 864e5}`);
  assert.equal(pub.status, 200);
  assert.equal((await pub.json()).summary.visitors, 2);

  // CSV export
  const csv = await (await fetch(`${BASE}/api/export?site=${site.id}&from=${Date.now() - 864e5}`, { headers: { Cookie: cookie } })).text();
  assert.equal(csv.trim().split('\n').length, 1 + 4);
});
