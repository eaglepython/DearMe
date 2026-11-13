'use strict';
// The analyst: sales and ad connections, plain-language questions, explanations, next steps, alerts, access.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const business = require('../lib/business');
const { parseQuestion, resolvePeriod } = require('../lib/analyst');

const PORT = 6000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
let proc, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-an-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_PASSWORD: 'op', STRIPE_SECRET_KEY: 'sk_test_x', ANTHROPIC_API_KEY: '', RESEND_API_KEY: '' }, stdio: 'ignore',
  });
  for (let i = 0; i < 200; i++) { try { await fetch(BASE + '/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
}
const hit = (body, ip, ua = UA) => fetch(BASE + '/api/event', { method: 'POST', body: JSON.stringify(body), headers: { 'User-Agent': ua, 'X-Forwarded-For': ip } });

test('money, dates and CSV exports are understood', () => {
  assert.equal(business.money('$1,234.50'), 1234.5);
  assert.equal(business.money('1.234,50 €'), 1234.5);
  assert.equal(business.money('12,5'), 12.5);
  assert.equal(new Date(business.toTs('2026-11-10')).toISOString().slice(0, 10), '2026-11-10');
  assert.equal(new Date(business.toTs('11/10/2026')).toISOString().slice(0, 10), '2026-11-10');
  assert.equal(new Date(business.toTs('Nov 10, 2026')).toISOString().slice(0, 10), '2026-11-10');
  const ads = business.parseAdsCsv('Campaign report\n"Nov 1, 2026 - Nov 2, 2026"\nDay,Campaign,Clicks,Impr.,Cost\n2026-11-01,Brand,10,500,"$12.50"\n2026-11-02,Brand,8,400,10\nTotal,,18,900,22.50\n', 'Google Ads');
  assert.equal(ads.length, 2);
  assert.equal(ads[0].channel, 'Google');
  const orders = business.parseOrdersCsv('Name,Created at,Total,Currency\n#1001,2026-11-01 10:00:00 +0000,49.00,USD\n#1002,2026-11-02 11:00:00 +0000,"1,099.00",USD\n');
  assert.deepEqual(orders.map((o) => [o.ref, o.amount]), [['order:1001', 49], ['order:1002', 1099]]);
  assert.equal(business.channelOf('l.facebook.com'), 'Meta');
  assert.equal(business.channelOf('Direct'), 'Direct');
});

test('questions in plain words become queries', () => {
  const known = { sources: ['Google', 'Reddit'], goals: ['Signup'], campaigns: ['spring-sale'], pages: ['/pricing'], channels: ['Google'] };
  const p = (q, prev) => parseQuestion(q, { known, previous: prev, countryNames: { FR: 'France' } });
  assert.deepEqual(p('How much did I make last month?').spec.metric, 'revenue');
  assert.equal(p('How much did I make last month?').spec.period, 'last_month');
  assert.equal(p('Where do my visitors come from?').spec.by, 'source');
  assert.equal(p('Which ads are worth it?').spec.metric, 'roas');
  assert.equal(p('Which ads are worth it?').spec.by, 'channel');
  assert.equal(p('Why did traffic drop?').intent, 'explain');
  assert.equal(p('What should I do next?').intent, 'advice');
  assert.deepEqual(p('conversion rate on mobile').spec.filters, { device: 'Mobile' });
  assert.deepEqual(p('visitors from France this week').spec.filters, { country: 'FR' });
  assert.equal(p('how many signups from reddit').spec.goal, 'Signup');
  assert.deepEqual(p('how many signups from reddit').spec.filters, { source: 'Reddit' });
  const prev = p('revenue by source this month').spec;
  assert.equal(p('and last month?', prev).spec.metric, 'revenue');
  assert.equal(p('and last month?', prev).spec.by, 'source');
  const r = resolvePeriod('last_month', Date.UTC(2026, 10, 13, 12), 0);
  assert.equal(new Date(r.from).toISOString().slice(0, 10), '2026-10-01');
  assert.equal(new Date(r.to).toISOString().slice(0, 10), '2026-11-01');
});

const owner = client(), viewer = client(), stranger = client();
let site, hook;

test('sales arrive from the tracker, a shop webhook and a CSV, without double counting', async () => {
  await owner('POST', '/api/signup', { name: 'Owner', email: 'owner@shop.test', password: 'password1' });
  site = (await owner('POST', '/api/sites', { domain: 'shop.test' })).body.id;
  // visitors: some from Google ads, some direct; two buy through the tracker
  for (let i = 0; i < 12; i++) await hit({ n: 'pageview', u: `https://shop.test/?utm_source=google&utm_medium=cpc&utm_campaign=brand`, d: 'shop.test', w: 1400 }, `10.0.0.${i}`);
  for (let i = 0; i < 8; i++) await hit({ n: 'pageview', u: 'https://shop.test/blog', d: 'shop.test', w: 400 }, `10.0.1.${i}`);
  await hit({ n: 'pageview', u: 'https://shop.test/checkout', d: 'shop.test', w: 1400 }, '10.0.0.1');
  await hit({ n: 'Purchase', u: 'https://shop.test/checkout', d: 'shop.test', w: 1400, p: { revenue: '99.00', order_id: '#5001' } }, '10.0.0.1');
  await hit({ n: 'Purchase', u: 'https://shop.test/checkout', d: 'shop.test', w: 1400, p: { revenue: 51 } }, '10.0.0.2');

  const data = (await owner('GET', `/api/sites/${site}/data`)).body;
  assert.equal(data.sales.orders, 2);
  hook = data.webhook.replace(/^https?:\/\/[^/]+/, '');
  // the shop reports order 5001 too: same order, not a new one
  const shopify = await fetch(BASE + hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 5001, order_number: 5001, total_price: '99.00', currency: 'USD', created_at: new Date().toISOString(), line_items: [] }) });
  assert.equal((await shopify.json()).provider, 'Shopify');
  const stripe = await fetch(BASE + hook, { method: 'POST', body: JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', amount_total: 2500, currency: 'usd', created: Math.floor(Date.now() / 1000), metadata: {} } } }) });
  assert.equal((await stripe.json()).orders, 1);
  assert.equal((await fetch(BASE + '/api/hooks/nope', { method: 'POST', body: '{}' })).status, 404);
  const after = (await owner('GET', `/api/sites/${site}/data`)).body;
  assert.equal(after.sales.orders, 3);
  assert.equal(after.sales.revenue, 175);

  const today = new Date().toISOString().slice(0, 10);
  const up = await owner('POST', `/api/sites/${site}/data`, { kind: 'ads', channel: 'Google Ads', csv: `Day,Campaign,Cost,Clicks\n${today},brand,50,30\n` });
  assert.equal(up.status, 201);
  assert.deepEqual(up.body.channels, ['Google']);
  assert.equal((await owner('POST', `/api/sites/${site}/data`, { kind: 'sales', csv: 'hello,world\n1,2' })).status, 400);
});

test('the analyst answers with numbers from the data', async () => {
  const ask = async (question, context) => (await owner('POST', `/api/sites/${site}/ask`, { question, context, tz: 0 })).body;
  const rev = await ask('How much did I make this week?');
  assert.equal(rev.spec.metric, 'revenue');
  assert.match(rev.answer, /\$175/);
  const src = await ask('Where do my visitors come from?');
  assert.equal(src.evidence.rows[0].label, 'google');
  assert.equal(src.evidence.rows[0].value, 12);
  const roas = await ask('Which ads are worth it?');
  assert.match(roas.answer, /Google/);
  assert.equal(roas.evidence.rows[0].value, 3); // $150 of tagged sales on $50 of spend
  const follow = await ask('and last month?', src.spec);
  assert.equal(follow.spec.by, 'source');
  const advice = await ask('What should I do next?');
  assert.ok(Array.isArray(advice.nextSteps) && advice.nextSteps.length);
  const why = await ask('Why did visitors change?');
  assert.equal(why.intent, 'explain');
  assert.match(why.answer, /went up|same/);
  const brief = (await owner('GET', `/api/sites/${site}/brief?tz=0`)).body;
  assert.deepEqual(brief.connected, { website: true, goals: true, sales: true, ads: true });
  assert.ok(brief.suggestions.length >= 4);
  assert.equal(brief.kpis.find((k) => k.metric === 'revenue').value, 175);
});

test('teammates can ask, other customers cannot', async () => {
  const inv = (await owner('POST', '/api/team/invite', { email: 'v@shop.test', role: 'viewer' })).body;
  await viewer('POST', `/api/invite/${inv.link.split('/').pop()}`, { password: 'password1' });
  assert.equal((await viewer('POST', `/api/sites/${site}/ask`, { question: 'visitors today' })).status, 200);
  assert.equal((await viewer('POST', `/api/sites/${site}/data`, { kind: 'sales', csv: 'x' })).status, 403);
  await stranger('POST', '/api/signup', { email: 'x@other.test', password: 'password1' });
  assert.equal((await stranger('POST', `/api/sites/${site}/ask`, { question: 'revenue' })).status, 404);
  assert.equal((await stranger('GET', `/api/sites/${site}/brief`)).status, 404);
});
