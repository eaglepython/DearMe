'use strict';
// Weekly email reports. Sends through Resend's HTTP API (free tier: 3,000 emails/month),
// so no SMTP library is needed. Set RESEND_API_KEY and REPORT_FROM to turn it on.

const { fmtDur } = require('./insights');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function emailEnabled() { return !!process.env.RESEND_API_KEY; }

async function sendEmail({ to, subject, html }) {
  if (!emailEnabled()) throw Object.assign(new Error('Email is not set up. Add RESEND_API_KEY and REPORT_FROM to your environment.'), { expose: true });
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.REPORT_FROM || 'Dear Me Analytics <onboarding@resend.dev>', to, subject, html }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) { throw Object.assign(new Error('Could not reach the email provider. Try again in a minute.'), { expose: true }); }
  if (!res.ok) throw Object.assign(new Error(`Email provider said ${res.status}: ${(await res.text()).slice(0, 200)}`), { expose: true });
  return true;
}

function reportHtml({ domain, facts, bullets, summary, dashboardUrl }) {
  const color = { good: '#1f8a4c', bad: '#c8412f', neutral: '#6b6f76' };
  const kpi = (label, value, change) => `<td style="padding:12px 16px;border:1px solid #e6e6e3;border-radius:10px">
      <div style="font-size:11px;color:#6b6f76;text-transform:uppercase;letter-spacing:.04em">${label}</div>
      <div style="font-size:24px;font-weight:700;color:#1c1d1f">${value}</div>
      ${change == null ? '' : `<div style="font-size:12px;font-weight:600;color:${change >= 0 ? color.good : color.bad}">${change >= 0 ? '↑' : '↓'} ${Math.abs(change)}%</div>`}</td>`;
  return `<!doctype html><html><body style="margin:0;background:#f7f7f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1d1f">
  <div style="max-width:560px;margin:0 auto;padding:28px 16px">
    <div style="font-weight:700;font-size:16px">Dear Me Analytics</div>
    <h1 style="font-size:22px;margin:6px 0 2px">Your week on ${esc(domain)}</h1>
    <div style="color:#6b6f76;font-size:13px;margin-bottom:18px">${esc(facts.period.from)} to ${esc(facts.period.to)}</div>
    <table cellspacing="8" style="width:100%;border-collapse:separate;margin:0 -8px"><tr>
      ${kpi('Visitors', facts.visitors.now.toLocaleString(), facts.visitors.before ? facts.visitors.change : null)}
      ${kpi('Pageviews', facts.pageviews.now.toLocaleString(), facts.pageviews.before ? facts.pageviews.change : null)}
      ${kpi('Visit time', fmtDur(facts.duration.now), null)}
    </tr></table>
    ${summary ? `<div style="background:#fff;border:1px solid #e6e6e3;border-radius:12px;padding:16px;margin:16px 0;line-height:1.55;white-space:pre-wrap">${esc(summary)}</div>` : ''}
    <div style="background:#fff;border:1px solid #e6e6e3;border-radius:12px;padding:6px 16px;margin:16px 0">
      ${bullets.map((b) => `<p style="margin:10px 0;line-height:1.5"><span style="color:${color[b.tone]}">●</span> ${esc(b.text)}</p>`).join('')}
    </div>
    ${dashboardUrl ? `<a href="${esc(dashboardUrl)}" style="display:inline-block;background:#5b5bd6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600">Open dashboard</a>` : ''}
    <p style="color:#9a9ca3;font-size:12px;margin-top:24px">You get this because you are on the weekly report list for ${esc(domain)}. Change it in the site settings.</p>
  </div></body></html>`;
}

module.exports = { sendEmail, emailEnabled, reportHtml };
