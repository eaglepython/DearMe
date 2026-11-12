/* Dear Me Analytics tracker. No cookies, no local storage, no fingerprinting.
   <script defer src="https://YOUR-ANALYTICS-HOST/script.js"></script>
   Optional attributes: data-domain="example.com", data-outbound (track outbound link clicks)
   Custom events: dearme('Signup', { plan: 'pro' }) */
(function (w, d) {
  'use strict';
  var s = d.currentScript;
  if (!s) return;
  var api = (s.getAttribute('data-api') || new URL(s.src).origin) + '/api/event';
  var domain = s.getAttribute('data-domain') || location.hostname;
  var local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname) || location.protocol === 'file:';
  var ignore = false;
  try { ignore = w.localStorage && localStorage.getItem('dearme_ignore') === 'true'; } catch (e) {}

  function send(name, props, extra) {
    if ((local && !s.hasAttribute('data-allow-local')) || ignore || w.navigator.webdriver) return;
    var body = { n: name, u: location.href, d: domain, r: d.referrer || null, w: w.innerWidth };
    try { body.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    if (props) body.p = props;
    if (extra) for (var k in extra) body[k] = extra[k];
    var data = JSON.stringify(body);
    if (navigator.sendBeacon && navigator.sendBeacon(api, new Blob([data], { type: 'text/plain' }))) return;
    try { fetch(api, { method: 'POST', body: data, keepalive: true, headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
  }

  // engagement: time the page was actually visible
  var shown = Date.now(), visible = 0, lastPath;
  function flush() {
    if (!d.hidden) visible += Date.now() - shown;
    if (visible > 1000) send('engagement', null, { e: visible });
    visible = 0; shown = Date.now();
  }
  d.addEventListener('visibilitychange', function () {
    if (d.hidden) flush(); else shown = Date.now();
  });

  function pageview() {
    if (lastPath === location.pathname) return;
    if (lastPath) flush();
    lastPath = location.pathname;
    send('pageview');
  }

  // single-page apps
  var push = history.pushState;
  if (push) {
    history.pushState = function () { push.apply(this, arguments); pageview(); };
    w.addEventListener('popstate', pageview);
  }

  if (s.hasAttribute('data-outbound')) {
    d.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (a && a.host && a.host !== location.host) send('Outbound Link', { url: a.href });
    }, true);
  }

  var queued = (w.dearme && w.dearme.q) || [];
  w.dearme = function (name, props) { send(String(name), props); };
  for (var i = 0; i < queued.length; i++) w.dearme.apply(null, queued[i]);

  if (d.visibilityState === 'prerender') d.addEventListener('visibilitychange', pageview, { once: true });
  else pageview();
})(window, document);
