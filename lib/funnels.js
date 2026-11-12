'use strict';
// Funnels: how many visits go through a sequence of steps, in order, within the same visit.
// A step is { type: 'page', value: '/pricing' } (supports * wildcards, e.g. /blog/*)
// or { type: 'event', value: 'Signup' }.

function stepMatcher(step) {
  if (step.type === 'event') return (e) => e.name === step.value;
  const v = String(step.value || '/');
  if (!v.includes('*')) return (e) => e.name === 'pageview' && e.path === v;
  const re = new RegExp('^' + v.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return (e) => e.name === 'pageview' && re.test(e.path);
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 8) return 'A funnel needs 2 to 8 steps';
  for (const s of steps) {
    if (!s || !['page', 'event'].includes(s.type) || !String(s.value || '').trim()) return 'Each step needs a page path or an event name';
    if (s.type === 'page' && !String(s.value).startsWith('/')) return 'Page steps start with /, like /pricing';
  }
  return null;
}

function computeFunnel(db, siteId, from, to, steps) {
  const matchers = steps.map(stepMatcher);
  const rows = db.prepare(`SELECT session_id, name, path FROM events
      WHERE site_id = ? AND ts >= ? AND ts < ? ORDER BY session_id, ts`).all(siteId, from, to);
  const reached = new Array(steps.length).fill(0);
  let current = null, idx = 0;
  const finish = () => { for (let i = 0; i < idx; i++) reached[i]++; };
  for (const e of rows) {
    if (e.session_id !== current) { if (current !== null) finish(); current = e.session_id; idx = 0; }
    if (idx < steps.length && matchers[idx](e)) idx++;
  }
  if (current !== null) finish();
  const first = reached[0] || 0;
  return steps.map((s, i) => ({
    ...s,
    visits: reached[i],
    conversion: first ? Math.round((1000 * reached[i]) / first) / 10 : 0,
    dropoff: i ? reached[i - 1] - reached[i] : 0,
    dropoffRate: i && reached[i - 1] ? Math.round((1000 * (reached[i - 1] - reached[i])) / reached[i - 1]) / 10 : 0,
  }));
}

module.exports = { computeFunnel, validateSteps };
