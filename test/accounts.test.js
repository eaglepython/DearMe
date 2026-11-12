'use strict';
// Accounts, isolation, roles, funnels, insights, Google Analytics import, plan limits.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 5000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
let proc, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-acc-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_PASSWORD: 'op', STRIPE_SECRET_KEY: 'sk_test_x', ANTHROPIC_API_KEY: '', RESEND_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
  };
}
const hit = (body, ip) => fetch(BASE + '/api/event', { method: 'POST', body: JSON.stringify(body), headers: { 'User-Agent': UA, 'X-Forwarded-For': ip } });

const alice = client(), bob = client(), op = client(), carol = client();
let siteA;

test('sign-up creates a trial account', async () => {
  assert.equal((await alice('POST', '/api/signup', { name: 'Alice', email: 'alice@a.test', password: 'short' })).status, 400);
  const r = await alice('POST', '/api/signup', { name: 'Alice', company: 'A Co', email: 'Alice@A.test', password: 'password1' });
  assert.equal(r.status, 201);
  assert.equal((await alice('POST', '/api/signup', { email: 'alice@a.test', password: 'password1' })).status, 409);
  const me = (await alice('GET', '/api/me')).body;
  assert.equal(me.account.plan, 'trial');
  assert.equal(me.account.siteLimit, 3);
  assert.equal(me.user.role, 'owner');
});

test('customers only see their own sites', async () => {
  siteA = (await alice('POST', '/api/sites', { domain: 'a.test' })).body.id;
  await carol('POST', '/api/signup', { email: 'carol@c.test', password: 'password1' });
  assert.equal((await carol('GET', `/api/stats?site=${siteA}`)).status, 401);
  assert.equal((await carol('GET', '/api/sites')).body.sites.length, 0);
  assert.equal((await carol('DELETE', `/api/sites/${siteA}`)).status, 404);
  await op('POST', '/api/login', { password: 'op' });
  assert.equal((await op('GET', `/api/stats?site=${siteA}`)).status, 401);
  const admin = (await op('GET', '/api/admin/accounts')).body;
  assert.equal(admin.accounts.length, 2);
  assert.equal((await alice('GET', '/api/admin/accounts')).status, 403);
});

test('plan site limit', async () => {
  await alice('POST', '/api/sites', { domain: 'b.test' });
  await alice('POST', '/api/sites', { domain: 'c.test' });
  const r = await alice('POST', '/api/sites', { domain: 'd.test' });
  assert.equal(r.status, 402);
});

test('invites and viewer role', async () => {
  const inv = (await alice('POST', '/api/team/invite', { email: 'bob@a.test', role: 'viewer' })).body;
  const token = inv.link.split('/invite/')[1];
  assert.equal((await bob('GET', `/api/invite/${token}`)).body.email, 'bob@a.test');
  assert.equal((await bob('POST', `/api/invite/${token}`, { name: 'Bob', password: 'password1' })).status, 201);
  assert.equal((await bob('GET', `/api/invite/${token}`)).status, 404); // used up
  assert.equal((await bob('GET', `/api/stats?site=${siteA}`)).status, 200);
  assert.equal((await bob('POST', '/api/sites', { domain: 'e.test' })).status, 403);
  assert.equal((await bob('GET', '/api/team')).status, 403);
  const team = (await alice('GET', '/api/team')).body;
  assert.equal(team.users.length, 2);
  const bobId = team.users.find((u) => u.email === 'bob@a.test').id;
  assert.equal((await alice('PATCH', `/api/team/users/${bobId}`, { role: 'admin' })).status, 200);
  assert.equal((await bob('POST', '/api/sites/' + siteA + '/funnels', { steps: [{ type: 'page', value: '/' }, { type: 'event', value: 'Signup' }] })).status, 201);
  // login with password works
  const b2 = client();
  assert.equal((await b2('POST', '/api/login', { email: 'bob@a.test', password: 'password1' })).status, 200);
  assert.equal((await b2('POST', '/api/login', { email: 'bob@a.test', password: 'nope' })).status, 401);
});

test('funnels count visits that follow the steps in order', async () => {
  // visitor 1: / -> /pricing -> Signup ; visitor 2: / only ; visitor 3: /pricing -> / (wrong order)
  await hit({ n: 'pageview', u: 'https://a.test/', w: 1200 }, '1.0.0.1');
  await hit({ n: 'pageview', u: 'https://a.test/pricing', w: 1200 }, '1.0.0.1');
  await hit({ n: 'Signup', u: 'https://a.test/pricing', w: 1200 }, '1.0.0.1');
  await hit({ n: 'pageview', u: 'https://a.test/', w: 1200 }, '1.0.0.2');
  await hit({ n: 'pageview', u: 'https://a.test/pricing', w: 1200 }, '1.0.0.3');
  const f = (await alice('POST', `/api/sites/${siteA}/funnels`, { name: 'Buy', steps: [{ type: 'page', value: '/' }, { type: 'page', value: '/pri*' }, { type: 'event', value: 'Signup' }] })).body;
  const r = (await alice('GET', `/api/funnel?site=${siteA}&id=${f.id}&from=${Date.now() - 864e5}&to=${Date.now() + 1000}`)).body;
  assert.deepEqual(r.steps.map((s) => s.visits), [2, 1, 1]);
  assert.equal(r.steps[2].conversion, 50);
  assert.equal((await alice('POST', `/api/sites/${siteA}/funnels`, { steps: [{ type: 'page', value: 'x' }] })).status, 400);
});

test('insights describe the week in plain words', async () => {
  const r = (await alice('GET', `/api/insights?site=${siteA}`)).body;
  assert.equal(r.facts.visitors.now, 3);
  assert.match(r.bullets[0].text, /3 visitors this week/);
  assert.equal(r.summary, null); // no AI key in tests
  const html = await alice('GET', `/api/sites/${siteA}/report/preview`);
  assert.match(html.body, /Your week on a\.test/);
  assert.equal((await alice('POST', `/api/sites/${siteA}/report/send`)).status, 400); // email not configured
});

test('Google Analytics CSV import merges into reports', async () => {
  const y = new Date().getFullYear(), m = String(new Date().getMonth() + 1).padStart(2, '0');
  const csv = `# Start date: ${y}${m}01\n# End date: ${y}${m}02\nDate,Active users,Views,Sessions\n${y}${m}01,100,250,120\n${y}${m}02,50,90,60\n`;
  const r = await alice('POST', `/api/sites/${siteA}/imports`, { filename: 'd.csv', csv });
  assert.equal(r.status, 201);
  assert.equal(r.body.dim, 'date');
  const pages = `# Start date: ${y}${m}01\n# End date: ${y}${m}02\nPage path and screen class,Views,Active users\n/,"1,000",400\n/old-page,10,8\n`;
  assert.equal((await alice('POST', `/api/sites/${siteA}/imports`, { filename: 'p.csv', csv: pages })).status, 201);
  assert.equal((await alice('POST', `/api/sites/${siteA}/imports`, { filename: 'x.csv', csv: 'hello,world\n1,2' })).status, 400);
  const from = Date.UTC(y, new Date().getMonth(), 1);
  const s = (await alice('GET', `/api/stats?site=${siteA}&from=${from}&to=${Date.now() + 1000}`)).body;
  assert.equal(s.imported, true);
  assert.equal(s.summary.visitors, 3 + 150);
  assert.ok(s.pages.find((p) => p.key === '/old-page'));
  // filters exclude imported data (it can't be broken down)
  const f = (await alice('GET', `/api/stats?site=${siteA}&from=${from}&page=/`)).body;
  assert.equal(f.imported, undefined);
  const list = (await alice('GET', `/api/sites/${siteA}/imports`)).body.imports;
  assert.equal(list.length, 2);
  await alice('DELETE', `/api/sites/${siteA}/imports/${list[0].id}`);
  assert.equal((await alice('GET', `/api/sites/${siteA}/imports`)).body.imports.length, 1);
});

test('Stripe webhook requires a valid signature', async () => {
  const r = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', body: '{}', headers: { 'Stripe-Signature': 't=1,v1=abc' } });
  assert.equal(r.status, 400);
});
