'use strict';
// Plans and Stripe billing, over Stripe's REST API (no SDK).
// Billing turns on when STRIPE_SECRET_KEY is set. Without it every account is unlimited (self-hosted mode).
const crypto = require('node:crypto');

const PLANS = {
  starter: { name: 'Starter', pageviews: 10_000, price: 9, sites: 3, env: 'STRIPE_PRICE_STARTER' },
  growth: { name: 'Growth', pageviews: 100_000, price: 19, sites: 10, env: 'STRIPE_PRICE_GROWTH' },
  business: { name: 'Business', pageviews: 1_000_000, price: 49, sites: 50, env: 'STRIPE_PRICE_BUSINESS' },
};
const TRIAL_DAYS = +process.env.TRIAL_DAYS || 14;
const TRIAL = { name: 'Free trial', pageviews: 50_000, price: 0, sites: 3 };

const billingEnabled = () => !!process.env.STRIPE_SECRET_KEY;

function planOf(account) {
  if (!billingEnabled()) return { id: 'unlimited', name: 'Unlimited', pageviews: Infinity, sites: Infinity, price: 0 };
  if (account.plan && PLANS[account.plan] && ['active', 'trialing', 'past_due'].includes(account.status)) return { id: account.plan, ...PLANS[account.plan] };
  return { id: 'trial', ...TRIAL };
}

// 'ok' | 'trial' | 'over_limit' | 'expired'
function accountState(account, monthPageviews) {
  if (!billingEnabled()) return 'ok';
  const plan = planOf(account);
  if (plan.id === 'trial') {
    if (Date.now() > account.trial_ends) return 'expired';
    return monthPageviews > plan.pageviews ? 'over_limit' : 'trial';
  }
  return monthPageviews > plan.pageviews ? 'over_limit' : 'ok';
}
// Keep counting a bit past the limit so nobody loses data the moment they cross it.
function acceptsEvents(account, monthPageviews) {
  if (!billingEnabled()) return true;
  const st = accountState(account, monthPageviews);
  if (st === 'expired') return Date.now() < account.trial_ends + 3 * 864e5; // 3-day grace
  if (st === 'over_limit') return monthPageviews < planOf(account).pageviews * 1.5;
  return true;
}

function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') form(v, key, out);
    else if (v !== undefined && v !== null) out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}
async function stripe(path, params) {
  const fail = (m) => Object.assign(new Error(m), { expose: true });
  let res;
  try {
    res = await fetch('https://api.stripe.com/v1/' + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form(params),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) { console.error('Stripe unreachable:', err.message); throw fail('Could not reach the payment provider. Try again in a minute.'); }
  const body = await res.json();
  if (!res.ok) throw fail(body.error?.message || `Payment provider error ${res.status}`);
  return body;
}

async function checkoutUrl(account, planId, email, baseUrl) {
  const plan = PLANS[planId];
  const price = plan && process.env[plan.env];
  if (!price) throw Object.assign(new Error(`Plan "${planId}" is not set up. Add ${plan ? plan.env : 'the price id'} to your environment.`), { expose: true });
  const session = await stripe('checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': 1,
    client_reference_id: account.id,
    customer: account.stripe_customer || undefined,
    customer_email: account.stripe_customer ? undefined : email,
    allow_promotion_codes: 'true',
    metadata: { account_id: account.id, plan: planId },
    'subscription_data[metadata][account_id]': account.id,
    'subscription_data[metadata][plan]': planId,
    success_url: `${baseUrl}/app?billing=success`,
    cancel_url: `${baseUrl}/app?billing=cancel`,
  });
  return session.url;
}

async function portalUrl(account, baseUrl) {
  if (!account.stripe_customer) throw Object.assign(new Error('No subscription yet'), { expose: true });
  return (await stripe('billing_portal/sessions', { customer: account.stripe_customer, return_url: `${baseUrl}/app` })).url;
}

// Stripe-Signature: t=...,v1=...
function verifyWebhook(payload, header) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - +parts.t) > 600) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

function planFromPrice(priceId) {
  return Object.keys(PLANS).find((k) => process.env[PLANS[k].env] === priceId) || null;
}

module.exports = { PLANS, TRIAL, TRIAL_DAYS, billingEnabled, planOf, accountState, acceptsEvents, checkoutUrl, portalUrl, verifyWebhook, planFromPrice };
