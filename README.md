# Dear Me Analytics

Simple, private website analytics you own. A cookie-free alternative to Google Analytics.

![Dashboard](docs/screenshot.png)

- **One script tag**, 1.3 KB gzipped (Google Analytics is ~45 KB+). Does not slow your site.
- **No cookies, no personal data.** Visitors are counted with a hash that changes every day, so no cookie banner is needed for it in most cases. IP addresses are never stored.
- **Everything on one screen:** unique visitors, visits, pageviews, bounce rate, visit duration, live visitors, top pages, entry and exit pages, sources, UTM campaigns, countries, browsers, OS, device size, and goals (signups, purchases, downloads).
- **Click anything to filter.** Click "Google" to see only Google traffic across every report.
- **Live updates.** The dashboard refreshes the moment a visitor arrives.
- **Share a public dashboard** with a read-only link, and **export to CSV** any time.
- **Works with single-page apps** (React, Vue, Next.js) automatically.
- **Zero dependencies.** One Node process and one SQLite file. No Postgres, no ClickHouse, no Redis.

## Deploy in one command

### Render (one click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/eaglepython/DearMe)

Click the button, sign in to Render, and press **Apply**. Render builds the Docker image, adds a 1 GB disk for your data, and generates an admin password (find it under **Environment** in the service). Your dashboard is live at `https://dear-me-analytics-xxxx.onrender.com` a few minutes later. This uses Render's Starter plan (about $7/month) because free instances have no persistent disk and would lose your stats on every deploy.

### Docker (any VPS, Synology, Raspberry Pi, your laptop)

```bash
docker compose up -d                       # uses ADMIN_PASSWORD from your shell, or "change-me"
# or
docker build -t dear-me . && docker run -d -p 3000:3000 -e ADMIN_PASSWORD=your-secret -v dearme:/data dear-me
```

Open `http://your-server:3000`, sign in, add your website, and paste the snippet it gives you into your site's `<head>`.

### Render, Railway, Fly.io, Coolify

Point the platform at this folder (or a GitHub repo containing it). It detects the Dockerfile. Set:

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Your dashboard password |
| `DATA_DIR` | no (default `/data` in Docker) | Where the database lives. Mount a persistent disk here. |
| `RETENTION_DAYS` | no (default: keep forever) | Delete data older than this many days |
| `PORT` | no (default `3000`) | Port to listen on |

Attach a persistent volume at `/data` so stats survive redeploys.

### Plain Node (no Docker)

Requires Node 22.5 or newer. No `npm install` needed.

```bash
ADMIN_PASSWORD=your-secret node server.js
```

## Add it to a website

```html
<script defer data-domain="example.com" src="https://stats.your-domain.com/script.js"></script>
```

Track goals:

```html
<script>window.dearme = window.dearme || function () { (dearme.q = dearme.q || []).push(arguments) }</script>
<button onclick="dearme('Signup', { plan: 'pro' })">Sign up</button>
```

Options on the script tag: `data-outbound` counts clicks on links to other sites. To exclude your own visits, run `localStorage.dearme_ignore = 'true'` in your browser console on your site.

Campaign links work out of the box: `?utm_source=newsletter&utm_campaign=launch`.

## Try it with demo data

```bash
npm run demo        # adds 90 days of realistic traffic for demo.example.com
npm start
```

## Run the tests

```bash
npm test
```

## How privacy works

For each pageview the server computes `sha256(daily_salt + site + ip + user_agent)` and keeps only the first 16 characters. The salt is random, changes every day, and the old one is deleted, so the same person can't be linked across days and the IP can't be recovered. Country comes from your CDN's country header (Cloudflare, Vercel, Fly) when present, otherwise from the browser's time zone. Bots, crawlers and headless browsers are filtered out.

## Put it behind HTTPS

Any reverse proxy works. With Caddy:

```
stats.your-domain.com {
  reverse_proxy localhost:3000
}
```

## Project layout

```
server.js          the whole backend: tracking endpoint, stats API, auth, static files
lib/ua.js          browser / OS detection and bot filter
lib/geo.js         time zone to country map
public/script.js   the tracker your websites load
public/            the dashboard (plain HTML, CSS, JS, no build step)
scripts/demo-data.js  fills the database with sample traffic
test/              end-to-end test
```
