'use strict';
// Tiny user-agent parser: browser + OS families only. No version fingerprinting, on purpose.

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|preview|facebookexternalhit|embedly|quora link|whatsapp|curl|wget|python-requests|httpclient|axios|node-fetch|go-http|java\/|phantomjs|puppeteer|playwright|selenium|vercel-screenshot|gtmetrix|semrush|ahrefs|mj12/i;

function isBot(ua) {
  return !ua || ua.length < 20 || BOT.test(ua);
}

function parseUA(ua) {
  let browser = 'Other';
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/YaBrowser/.test(ua)) browser = 'Yandex';
  else if (/Vivaldi/.test(ua)) browser = 'Vivaldi';
  else if (/Brave/.test(ua)) browser = 'Brave';
  else if (/FBAN|FBAV|Instagram/.test(ua)) browser = 'In-app (Meta)';
  else if (/Firefox|FxiOS/.test(ua)) browser = 'Firefox';
  else if (/Chrome|CriOS|Chromium/.test(ua)) browser = 'Chrome';
  else if (/Safari/.test(ua)) browser = 'Safari';

  let os = 'Other';
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  return { browser, os };
}

module.exports = { parseUA, isBot };
