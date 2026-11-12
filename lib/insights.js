'use strict';
// Insights: compares the last 7 days with the 7 before, finds what moved, and says it in plain words.
// Works with no setup. If ANTHROPIC_API_KEY is set, Claude also writes a short narrative
// summary with suggestions on top of the same facts.

const DAY = 864e5;
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : a ? 100 : 0);
const fmtDur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);

function movers(cur, prev, label, minChange = 5) {
  const p = Object.fromEntries(prev.map((r) => [r.key, r.visitors]));
  const c = Object.fromEntries(cur.map((r) => [r.key, r.visitors]));
  const keys = new Set([...Object.keys(p), ...Object.keys(c)]);
  const out = [];
  for (const k of keys) {
    if (k === '(none)') continue;
    const d = (c[k] || 0) - (p[k] || 0);
    if (Math.abs(d) >= minChange) out.push({ key: k, label, now: c[k] || 0, before: p[k] || 0, change: d, isNew: !p[k] });
  }
  return out.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

// statsFn(siteId, params: URLSearchParams) is the dashboard's own stats function.
function buildFacts(statsFn, siteId, now = Date.now()) {
  const end = now, start = now - 7 * DAY;
  const q = (from, to) => statsFn(siteId, new URLSearchParams({ from, to, bucket: 'day', limit: 50 }));
  const cur = q(start, end);
  const prev = q(start - 7 * DAY, start);
  const s = cur.summary, ps = prev.summary;

  const goals = cur.events.map((g) => {
    const before = prev.events.find((x) => x.key === g.key);
    return { name: g.key, conversions: g.visitors, rate: s.visitors ? Math.round((1000 * g.visitors) / s.visitors) / 10 : 0,
      ratePrev: before && ps.visitors ? Math.round((1000 * before.visitors) / ps.visitors) / 10 : 0 };
  });
  const bestDay = [...cur.series].sort((a, b) => b.visitors - a.visitors)[0] || null;
  const mobile = cur.devices.find((d) => d.key === 'Mobile');

  return {
    period: { from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) },
    visitors: { now: s.visitors, before: ps.visitors, change: pct(s.visitors, ps.visitors) },
    pageviews: { now: s.pageviews, before: ps.pageviews, change: pct(s.pageviews, ps.pageviews) },
    bounceRate: { now: s.bounceRate, before: ps.bounceRate },
    duration: { now: s.duration, before: ps.duration },
    topSource: cur.sources[0] ? { name: cur.sources[0].key, share: s.visitors ? Math.round((100 * cur.sources[0].visitors) / s.visitors) : 0 } : null,
    topPage: cur.pages[0] ? { path: cur.pages[0].key, visitors: cur.pages[0].visitors } : null,
    sourceMovers: movers(cur.sources, prev.sources, 'source').slice(0, 4),
    pageMovers: movers(cur.pages, prev.pages, 'page').slice(0, 4),
    countryMovers: movers(cur.countries, prev.countries, 'country').slice(0, 3),
    goals,
    bestDay: bestDay && bestDay.visitors ? { day: bestDay.t, visitors: bestDay.visitors } : null,
    mobileShare: mobile && s.visitors ? Math.round((100 * mobile.visitors) / s.visitors) : 0,
  };
}

// Plain-English bullet points, no AI needed.
function bullets(f) {
  const out = [];
  const v = f.visitors;
  if (!v.now && !v.before) return [{ tone: 'neutral', text: 'No visitors yet in the last two weeks. Once your tracking snippet is live, insights appear here.' }];
  if (v.before) {
    const dir = v.change > 0 ? 'up' : v.change < 0 ? 'down' : 'flat';
    out.push({ tone: v.change >= 5 ? 'good' : v.change <= -5 ? 'bad' : 'neutral',
      text: `${v.now.toLocaleString()} visitors this week, ${dir === 'flat' ? 'about the same as' : `${dir} ${Math.abs(v.change)}% from`} last week (${v.before.toLocaleString()}).` });
  } else out.push({ tone: 'good', text: `${v.now.toLocaleString()} visitors this week, your first week of data.` });

  for (const m of f.sourceMovers.slice(0, 2)) {
    if (m.isNew) out.push({ tone: 'good', text: `New traffic source: ${m.key} sent ${m.now} visitors this week.` });
    else out.push({ tone: m.change > 0 ? 'good' : 'bad', text: `${m.key} sent ${m.change > 0 ? m.change + ' more' : -m.change + ' fewer'} visitors than last week (${m.before} → ${m.now}).` });
  }
  const pm = f.pageMovers.find((m) => m.change > 0);
  if (pm) out.push({ tone: 'good', text: `${pm.key} is gaining attention: ${pm.now} visitors, up from ${pm.before}.` });
  const pd = f.pageMovers.find((m) => m.change < 0);
  if (pd) out.push({ tone: 'bad', text: `${pd.key} lost visitors: ${pd.now}, down from ${pd.before}.` });

  const b = f.bounceRate;
  if (b.before && Math.abs(b.now - b.before) >= 5)
    out.push({ tone: b.now < b.before ? 'good' : 'bad', text: `Bounce rate ${b.now < b.before ? 'improved' : 'worsened'} to ${b.now}% (was ${b.before}%).` });
  for (const g of f.goals.slice(0, 2)) {
    const d = Math.round((g.rate - g.ratePrev) * 10) / 10;
    out.push({ tone: d > 0 ? 'good' : d < 0 ? 'bad' : 'neutral',
      text: `${g.name}: ${g.conversions} conversions, ${g.rate}% of visitors${g.ratePrev ? ` (${d >= 0 ? '+' : ''}${d} points vs last week)` : ''}.` });
  }
  if (f.mobileShare >= 50) out.push({ tone: 'neutral', text: `${f.mobileShare}% of visitors are on phones. Make sure your key pages shine on mobile.` });
  if (f.bestDay) out.push({ tone: 'neutral', text: `Best day: ${new Date(f.bestDay.day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} with ${f.bestDay.visitors} visitors.` });
  return out.slice(0, 8);
}

// Optional: a short narrative from Claude. Raw HTTPS so the project keeps zero dependencies.
async function aiSummary(domain, facts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const body = {
    model: process.env.INSIGHTS_MODEL || 'claude-opus-5-5',
    max_tokens: 2000,
    output_config: { effort: 'low' },
    system: 'You are a friendly web analytics advisor for a small website owner. Write in plain, warm English with no jargon. ' +
      'Use only the numbers in the data you are given; never invent figures. Reply with two short paragraphs: ' +
      'first, what happened this week and the most likely reason; second, one or two concrete things to do next. Under 120 words. No headings, no bullet points, no markdown.',
    messages: [{ role: 'user', content: `Website: ${domain}\nThis week vs last week, as JSON:\n${JSON.stringify(facts)}` }],
  };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) { console.error('Insights AI error', res.status, (await res.text()).slice(0, 300)); return null; }
    const msg = await res.json();
    if (msg.stop_reason === 'refusal') return null;
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
  } catch (err) {
    console.error('Insights AI request failed:', err.message);
    return null;
  }
}

module.exports = { buildFacts, bullets, aiSummary, fmtDur };
