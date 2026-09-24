![hero](apps/public/public/ogimage.png)

<p align="center">
	<h1 align="center"><b>Openpanel</b></h1>
<p align="center">
    An open-source alternative to Mixpanel
    <br />
    <br />
    <a href="https://openpanel.dev">Website</a>
    ·
    <a href="https://openpanel.dev/docs">Docs</a>
    ·
    <a href="https://dashboard.openpanel.dev">Sign in</a>
    ·
    <a href="https://go.openpanel.dev/discord">Discord</a>
    ·
    <a href="https://twitter.com/OpenPanelDev">X/Twitter</a>
    ·
    <a href="https://twitter.com/CarlLindesvard">Creator</a>
    ·
  </p>
  <br />
  <br />
</p>
  
Openpanel is an open-source web and product analytics platform that combines the power of Mixpanel with the ease of Plausible and one of the best Google Analytics replacements.

## ✨ Features

- **🔍 Advanced Analytics**: Funnels, cohorts, user profiles, and session history
- **🎬 Session Replay**: Record and replay user sessions with privacy controls built in
- **📊 Real-time Dashboards**: Live data updates and interactive charts
- **🎯 A/B Testing**: Built-in variant testing with detailed breakdowns
- **🔔 Smart Notifications**: Event and funnel-based alerts
- **🌍 Privacy-First**: Cookieless tracking and GDPR compliance
- **🚀 Developer-Friendly**: Comprehensive SDKs and API access
- **📦 Self-Hosted**: Full control over your data and infrastructure
- **💸 Transparent Pricing**: No hidden costs or usage limits
- **🛠️ Custom Dashboards**: Flexible chart creation and data visualization
- **📱 Multi-Platform**: Web, mobile (iOS/Android), and server-side tracking
- **🤖 MCP Server**: Ask Claude, Cursor, or any MCP client about your users — 38 tools, hosted, no install
- **💰 Revenue Tracking**: Monitor purchases, subscriptions, and LTV alongside product events
- **🔌 Integrations**: Connect Google Search Console, and more to enrich your data

## 📊 Analytics Platform Comparison

| Feature                                | OpenPanel | Mixpanel | GA4       | Plausible |
|----------------------------------------|-----------|----------|-----------|-----------|
| ✅ Open-source                         | ✅         | ❌        | ❌        | ✅         |
| 🧩 Self-hosting supported              | ✅         | ❌        | ❌        | ✅         |
| 🔒 Cookieless by default               | ✅         | ❌        | ❌        | ✅         |
| 🔁 Real-time dashboards                | ✅         | ✅        | ❌        | ✅         |
| 🔍 Funnels & cohort analysis           | ✅         | ✅        | ✅*       | ✅***         |
| 👤 User profiles & session history     | ✅         | ✅        | ❌        | ❌         |
| 🎬 Session replay                      | ✅         | ✅****    | ❌        | ❌         |
| 📈 Custom dashboards & charts          | ✅         | ✅        | ✅        | ❌         |
| 💬 Event & funnel notifications        | ✅         | ✅        | ❌        | ❌         |
| 🌍 GDPR-compliant tracking             | ✅         | ✅        | ❌**      | ✅         |
| 📦 SDKs (Web, Swift, Kotlin, ReactNative) | ✅      | ✅        | ✅        | ❌         |
| 💸 Transparent pricing                 | ✅         | ❌        | ✅*       | ✅         |
| 🚀 Built for developers                | ✅         | ✅        | ❌        | ✅         |
| 🔧 A/B testing & variant breakdowns    | ✅         | ✅        | ❌        | ❌         |

> ✅* GA4 has a free tier but often requires BigQuery (paid) for raw data access.
> ❌** GA4 has faced GDPR bans in several EU countries due to data transfers to US-based servers.
> ✅*** Plausible has simple goals
> ✅**** Mixpanel session replay is limited to 5k sessions/month on free and 20k on paid. OpenPanel has no limit.

## Stack

This branch runs OpenPanel entirely on Cloudflare, with Neon Postgres as its
only database.

- **TanStack Start** on Workers - the dashboard
- **Hono** on Workers - the event and public API
- **Neon Postgres** - all data: accounts and projects (Prisma) and the events
  (the `analytics` schema). Through **Hyperdrive** where someone waits on the
  answer, over a direct connection for background work
- **Queues**, **Cron Triggers** and **Workflows** - ingestion, background jobs,
  backups
- **Durable Objects** - realtime WebSockets
- **Workers rate limiting** - API rate limits
- **R2** - backups
- **Cloudflare Email Service** - email
- **Arctic** - oauth
- **Oslo** - auth
- **tRPC** - api
- **Tailwind** - styling
- **Shadcn** - ui
- **vinext** - the website and docs

## Self-hosting

OpenPanel deploys to your own Cloudflare account and Neon project. See
[Deploying on Cloudflare](./tooling/cloudflare/DEPLOY.md).

**Give us a star if you like it!**

[![Star History Chart](https://api.star-history.com/svg?repos=Openpanel-dev/openpanel&type=Date)](https://star-history.com/#Openpanel-dev/openpanel&Date)

## Development

### Prerequisites

- Node and pnpm
- Postgres 16 or newer (`pnpm dock:up` starts one with Docker Compose)

### Start

```bash
pnpm install
cp .env.example .env
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/worker/.dev.vars.example apps/worker/.dev.vars

pnpm dock:up
pnpm codegen
pnpm migrate:deploy # once to set up the database
pnpm dev
```

`pnpm dev` starts the API and the worker under `wrangler dev`, and the
dashboard under Vite. The Workers find each other through wrangler's local dev
registry: the API's queue feeds the worker's consumer, and the worker publishes
to the API's LiveHub.

You can now access the following:

- Dashboard: http://localhost:3000
- API: http://localhost:3333
- Worker: http://localhost:9999 (`/__scheduled?cron=*+*+*+*+*` runs a cron,
  here the session reaper)
- `pnpm dock:psql` opens a Postgres shell
